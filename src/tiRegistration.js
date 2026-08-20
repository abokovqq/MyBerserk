import './env.js';

import {
  q
} from './db.js';

import {
  gizmoFetch
} from './gizmoClient.js';


// ==================================================
// PHONE NORMALIZATION
// ==================================================

export function normalizeTiPhone(
  value
) {
  let digits =
    String(value || '')
      .replace(/\D/g, '');


  if (!digits) {
    return null;
  }


  if (
    digits.length === 10
  ) {
    digits =
      '7' + digits;
  }


  if (
    digits.length === 11 &&
    digits.startsWith('8')
  ) {
    digits =
      '7' + digits.slice(1);
  }


  return digits;
}


// ==================================================
// GIZMO USERS + SHORT CACHE
// ==================================================

const TI_GIZMO_USERS_CACHE_MS =
  2 * 60 * 1000;


let tiGizmoUsersCache =
  null;


let tiGizmoUsersCacheAt =
  0;


let tiGizmoUsersFetchPromise =
  null;


export async function getTiGizmoUsers({
  force = false
} = {}) {
  const cacheFresh =
    Array.isArray(
      tiGizmoUsersCache
    ) &&
    (
      Date.now() -
      tiGizmoUsersCacheAt
    ) < TI_GIZMO_USERS_CACHE_MS;


  if (
    !force &&
    cacheFresh
  ) {
    return tiGizmoUsersCache;
  }


  if (
    tiGizmoUsersFetchPromise
  ) {
    return tiGizmoUsersFetchPromise;
  }


  tiGizmoUsersFetchPromise =
    (async () => {
      const response =
        await gizmoFetch(
          '/api/users'
        );


      if (
        !response ||
        !Array.isArray(response.result)
      ) {
        throw new Error(
          'Gizmo /api/users returned unexpected response'
        );
      }


      tiGizmoUsersCache =
        response.result;


      tiGizmoUsersCacheAt =
        Date.now();


      return tiGizmoUsersCache;
    })();


  try {
    return await tiGizmoUsersFetchPromise;

  } finally {
    tiGizmoUsersFetchPromise =
      null;
  }
}


function findTiGizmoUsersByPhoneInList(
  users,
  phone
) {
  const normalized =
    normalizeTiPhone(
      phone
    );


  if (!normalized) {
    return [];
  }


  return users.filter(
    user => {
      const phone1 =
        normalizeTiPhone(
          user.phone
        );

      const phone2 =
        normalizeTiPhone(
          user.mobilePhone
        );


      return (
        phone1 === normalized ||
        phone2 === normalized
      );
    }
  );
}


// ==================================================
// FIND GIZMO USER BY PHONE
// ==================================================

export async function findTiGizmoUsersByPhone(
  phone,
  {
    force = false
  } = {}
) {
  const users =
    await getTiGizmoUsers({
      force
    });


  return findTiGizmoUsersByPhoneInList(
    users,
    phone
  );
}


// ==================================================
// TELEGRAM CONTACT VALIDATION
// ==================================================

export function validateTiTelegramContact(
  message
) {
  const contact =
    message?.contact;

  const from =
    message?.from;


  if (
    !contact ||
    !from
  ) {
    return {
      ok: false,
      reason: 'no_contact'
    };
  }


  if (
    !contact.phone_number
  ) {
    return {
      ok: false,
      reason: 'no_phone'
    };
  }


  if (
    Number(contact.user_id) !==
    Number(from.id)
  ) {
    return {
      ok: false,
      reason: 'foreign_contact'
    };
  }


  const normalized =
    normalizeTiPhone(
      contact.phone_number
    );


  if (!normalized) {
    return {
      ok: false,
      reason: 'invalid_phone'
    };
  }


  return {
    ok: true,
    phone:
      contact.phone_number,
    phoneNormalized:
      normalized
  };
}


// ==================================================
// SAVE VERIFIED TELEGRAM PHONE + GIZMO MATCH
// ==================================================

export async function registerTiPhone(
  message
) {
  const validation =
    validateTiTelegramContact(
      message
    );


  if (!validation.ok) {
    return validation;
  }


  const telegramId =
    Number(
      message.from.id
    );


  const rows =
    await q(
      `
        SELECT *

        FROM ti_users

        WHERE telegram_id = ?

        LIMIT 1
      `,
      [
        telegramId
      ]
    );


  const tiUser =
    rows[0] || null;


  if (!tiUser) {
    return {
      ok: false,
      reason: 'ti_user_not_found'
    };
  }


  if (
    tiUser.privacy_withdrawal_requested_at
  ) {
    return {
      ok: false,
      reason: 'privacy_withdrawn'
    };
  }


  if (
    !tiUser.rules_accepted_at ||
    !tiUser.privacy_consent_at ||
    (
      tiUser.rating_name_mode !== 'name' &&
      tiUser.rating_name_mode !== 'pseudonym'
    )
  ) {
    return {
      ok: false,
      reason: 'legal_consent_required'
    };
  }


  // Уже подтверждённый админом пользователь
  // не должен случайно потерять approve,
  // если повторно отправил ТОТ ЖЕ Telegram contact.
  if (
    Number(tiUser.phone_verified) === 1 &&
    tiUser.registration_status === 'approved' &&
    String(tiUser.phone_normalized || '') ===
      String(validation.phoneNormalized)
  ) {
    return {
      ok: true,
      alreadyApproved: true,
      phone:
        validation.phone,
      phoneNormalized:
        validation.phoneNormalized,
      gizmoMatchStatus:
        tiUser.gizmo_match_status,
      gizmoUsers:
        [],
      tiUserId:
        tiUser.id
    };
  }


  // Номер Telegram уже подтверждён.
  // Поэтому прогнозы должны открыться даже если
  // Gizmo API временно недоступен.
  await q(
    `
      UPDATE ti_users

      SET
        phone = ?,
        phone_normalized = ?,
        phone_verified = 1,

        registration_status =
          'pending_admin',

        gizmo_match_status =
          'checking',

        gizmo_user_id = NULL,
        gizmo_username = NULL,
        gizmo_first_name = NULL,
        gizmo_last_name = NULL,

        admin_verified_by = NULL,
        admin_verified_at = NULL,
        rejected_at = NULL

      WHERE id = ?
    `,
    [
      validation.phone,
      validation.phoneNormalized,
      tiUser.id
    ]
  );


  let gizmoUsers = [];


  try {
    gizmoUsers =
      await findTiGizmoUsersByPhone(
        validation.phoneNormalized
      );

  } catch (err) {
    await q(
      `
        UPDATE ti_users

        SET
          gizmo_match_status =
            'error'

        WHERE id = ?
      `,
      [
        tiUser.id
      ]
    );


    console.error(
      new Date().toISOString(),
      '[TI REG] Gizmo lookup error:',
      err
    );


    return {
      ok: true,
      phone:
        validation.phone,
      phoneNormalized:
        validation.phoneNormalized,
      gizmoMatchStatus:
        'error',
      gizmoUsers:
        [],
      tiUserId:
        tiUser.id
    };
  }


  let gizmoMatchStatus =
    'not_found';

  let gizmoUser =
    null;


  if (
    gizmoUsers.length === 1
  ) {
    gizmoMatchStatus =
      'exact';

    gizmoUser =
      gizmoUsers[0];

  } else if (
    gizmoUsers.length > 1
  ) {
    gizmoMatchStatus =
      'multiple';
  }


  await q(
    `
      UPDATE ti_users

      SET
        gizmo_match_status = ?,

        gizmo_user_id = ?,
        gizmo_username = ?,
        gizmo_first_name = ?,
        gizmo_last_name = ?

      WHERE id = ?
    `,
    [
      gizmoMatchStatus,

      gizmoUser
        ? Number(gizmoUser.id)
        : null,

      gizmoUser?.username || null,
      gizmoUser?.firstName || null,
      gizmoUser?.lastName || null,

      tiUser.id
    ]
  );


  return {
    ok: true,
    phone:
      validation.phone,
    phoneNormalized:
      validation.phoneNormalized,
    gizmoMatchStatus,
    gizmoUsers,
    tiUserId:
      tiUser.id
  };
}


// ==================================================
// REFRESH ONE GIZMO SNAPSHOT
//
// Если gizmo_user_id уже известен, это главный
// идентификатор связи. Изменение телефона, логина
// или имени в Gizmo не разрывает привязку.
//
// Если ID ещё не найден, повторяем поиск по
// подтверждённому Telegram-телефону.
// ==================================================

async function saveExactTiGizmoSnapshot(
  tiUserId,
  gizmoUser
) {
  await q(
    `
      UPDATE ti_users

      SET
        gizmo_match_status =
          'exact',

        gizmo_user_id = ?,
        gizmo_username = ?,
        gizmo_first_name = ?,
        gizmo_last_name = ?

      WHERE id = ?
    `,
    [
      Number(gizmoUser.id),
      gizmoUser.username || null,
      gizmoUser.firstName || null,
      gizmoUser.lastName || null,
      tiUserId
    ]
  );
}


export async function refreshTiRegistration(
  userId,
  {
    force = false,
    users = null
  } = {}
) {
  const tiUser =
    await getTiRegistration(
      userId
    );


  if (!tiUser) {
    return {
      ok: false,
      reason: 'ti_user_not_found'
    };
  }


  if (
    Number(
      tiUser.phone_verified
    ) !== 1
  ) {
    return {
      ok: true,
      skipped: true,
      reason: 'phone_not_verified'
    };
  }


  const gizmoUsers =
    users ||
    await getTiGizmoUsers({
      force
    });


  // Уже связанная карточка всегда обновляется
  // по постоянному Gizmo ID.
  if (tiUser.gizmo_user_id) {
    const linked =
      gizmoUsers.find(
        item =>
          Number(item.id) ===
          Number(
            tiUser.gizmo_user_id
          )
      );


    if (linked) {
      await saveExactTiGizmoSnapshot(
        tiUser.id,
        linked
      );


      return {
        ok: true,
        matchStatus: 'exact',
        source: 'gizmo_id',
        gizmoUserId:
          Number(linked.id)
      };
    }


    // Для уже подтверждённого пользователя
    // не переключаем личность автоматически
    // на другую карточку только по телефону.
    if (
      tiUser.registration_status ===
        'approved'
    ) {
      await q(
        `
          UPDATE ti_users

          SET
            gizmo_match_status =
              'not_found'

          WHERE id = ?
        `,
        [
          tiUser.id
        ]
      );


      return {
        ok: true,
        matchStatus: 'not_found',
        source: 'missing_gizmo_id',
        gizmoUserId:
          Number(
            tiUser.gizmo_user_id
          )
      };
    }
  }


  const matches =
    findTiGizmoUsersByPhoneInList(
      gizmoUsers,
      tiUser.phone_normalized ||
        tiUser.phone
    );


  if (matches.length === 1) {
    const match =
      matches[0];


    await saveExactTiGizmoSnapshot(
      tiUser.id,
      match
    );


    return {
      ok: true,
      matchStatus: 'exact',
      source: 'phone',
      gizmoUserId:
        Number(match.id)
    };
  }


  if (matches.length > 1) {
    await q(
      `
        UPDATE ti_users

        SET
          gizmo_match_status =
            'multiple',

          gizmo_user_id = NULL,
          gizmo_username = NULL,
          gizmo_first_name = NULL,
          gizmo_last_name = NULL

        WHERE id = ?
      `,
      [
        tiUser.id
      ]
    );


    return {
      ok: true,
      matchStatus: 'multiple',
      matches:
        matches.length
    };
  }


  await q(
    `
      UPDATE ti_users

      SET
        gizmo_match_status =
          'not_found',

        gizmo_user_id = NULL,
        gizmo_username = NULL,
        gizmo_first_name = NULL,
        gizmo_last_name = NULL

      WHERE id = ?
    `,
    [
      tiUser.id
    ]
  );


  return {
    ok: true,
    matchStatus: 'not_found'
  };
}


// ==================================================
// REGULAR REFRESH OF ALL ACTIVE TI CARDS
//
// Один вызов /api/users на весь проход.
// ==================================================

export async function refreshTiRegistrations({
  force = true
} = {}) {
  const tiUsers =
    await q(
      `
        SELECT *

        FROM ti_users

        WHERE
          is_active = 1

          AND phone_verified = 1

          AND rules_accepted_at IS NOT NULL

          AND privacy_consent_at IS NOT NULL

          AND rating_name_mode
            IN (
              'name',
              'pseudonym'
            )

          AND privacy_withdrawal_requested_at IS NULL

          AND registration_status
            IN (
              'pending_admin',
              'approved'
            )

        ORDER BY id ASC
      `
    );


  if (!tiUsers.length) {
    return {
      total: 0,
      exact: 0,
      multiple: 0,
      notFound: 0
    };
  }


  const gizmoUsers =
    await getTiGizmoUsers({
      force
    });


  const result = {
    total:
      tiUsers.length,
    exact: 0,
    multiple: 0,
    notFound: 0
  };


  for (const tiUser of tiUsers) {
    const refreshed =
      await refreshTiRegistration(
        tiUser.id,
        {
          users: gizmoUsers
        }
      );


    if (
      refreshed.matchStatus ===
        'exact'
    ) {
      result.exact += 1;

    } else if (
      refreshed.matchStatus ===
        'multiple'
    ) {
      result.multiple += 1;

    } else if (
      refreshed.matchStatus ===
        'not_found'
    ) {
      result.notFound += 1;
    }
  }


  return result;
}


// ==================================================
// PENDING REGISTRATIONS
// ==================================================

export async function getPendingTiRegistrations() {
  return q(
    `
      SELECT *

      FROM ti_users

      WHERE
        phone_verified = 1

        AND rules_accepted_at IS NOT NULL

        AND privacy_consent_at IS NOT NULL

        AND rating_name_mode
          IN (
            'name',
            'pseudonym'
          )

        AND privacy_withdrawal_requested_at IS NULL

        AND registration_status =
          'pending_admin'

      ORDER BY
        updated_at ASC,
        id ASC
    `
  );
}


// ==================================================
// GET REGISTRATION
// ==================================================

export async function getTiRegistration(
  userId
) {
  const rows =
    await q(
      `
        SELECT *

        FROM ti_users

        WHERE id = ?

        LIMIT 1
      `,
      [
        userId
      ]
    );


  return rows[0] || null;
}


// ==================================================
// APPROVE
// ==================================================

export async function approveTiRegistration({
  userId,
  adminTelegramId
}) {
  const result =
    await q(
      `
        UPDATE ti_users

        SET
          registration_status =
            'approved',

          admin_verified_by = ?,

          admin_verified_at =
            CURRENT_TIMESTAMP,

          rejected_at = NULL

        WHERE id = ?

          AND phone_verified = 1

          AND rules_accepted_at IS NOT NULL

          AND privacy_consent_at IS NOT NULL

          AND rating_name_mode
            IN (
              'name',
              'pseudonym'
            )

          AND privacy_withdrawal_requested_at IS NULL
      `,
      [
        adminTelegramId,
        userId
      ]
    );


  return {
    changed:
      Number(
        result?.affectedRows || 0
      ) > 0
  };
}


// ==================================================
// REJECT
// ==================================================

export async function rejectTiRegistration({
  userId,
  adminTelegramId
}) {
  const result =
    await q(
      `
        UPDATE ti_users

        SET
          registration_status =
            'rejected',

          admin_verified_by = ?,

          admin_verified_at =
            CURRENT_TIMESTAMP,

          rejected_at =
            CURRENT_TIMESTAMP

        WHERE id = ?

          AND phone_verified = 1
      `,
      [
        adminTelegramId,
        userId
      ]
    );


  return {
    changed:
      Number(
        result?.affectedRows || 0
      ) > 0
  };
}


// ==================================================
// CAN USER MAKE PREDICTIONS?
// ==================================================

export function canTiUserPredict(
  user
) {
  return Boolean(
    user &&
    Number(user.is_active) === 1 &&
    Number(user.phone_verified) === 1 &&
    Boolean(user.rules_accepted_at) &&
    Boolean(user.privacy_consent_at) &&
    (
      user.rating_name_mode === 'name' ||
      user.rating_name_mode === 'pseudonym'
    ) &&
    !user.privacy_withdrawal_requested_at
  );
}


// ==================================================
// CAN USER RECEIVE REWARDS?
// ==================================================

export function canTiUserReceiveRewards(
  user
) {
  return Boolean(
    canTiUserPredict(user) &&
    user.registration_status ===
      'approved' &&
    user.rating_group ===
      'main'
  );
}
