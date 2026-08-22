import { q } from './db.js';


// ==================================================
// REGISTER USER
// ==================================================

export async function registerTiUser(
  tgUser
) {
  await q(
    `
      INSERT INTO ti_users (
        telegram_id,
        username,
        first_name,
        last_name
      )

      VALUES (
        ?,
        ?,
        ?,
        ?
      )

      ON DUPLICATE KEY UPDATE

        username =
          VALUES(username),

        first_name =
          VALUES(first_name),

        last_name =
          VALUES(last_name)
    `,
    [
      tgUser.id,

      tgUser.username ||
        null,

      tgUser.first_name ||
        null,

      tgUser.last_name ||
        null
    ]
  );


  return getTiUserByTelegramId(
    tgUser.id
  );
}


// ==================================================
// GET USER BY TELEGRAM ID
// ==================================================

export async function getTiUserByTelegramId(
  telegramId
) {
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


  return (
    rows[0] ||
    null
  );
}


// ==================================================
// OPEN MATCHES
// ==================================================

export async function getOpenTiMatches() {
  return q(
    `
      SELECT *

      FROM ti_matches

      WHERE
        status = 'scheduled'

        AND betting_closed = 0

        AND start_time > NOW()

      ORDER BY
        start_time ASC
    `
  );
}


// ==================================================
// GET MATCH
// ==================================================

export async function getTiMatch(
  matchId
) {
  const rows =
    await q(
      `
        SELECT *

        FROM ti_matches

        WHERE id = ?

        LIMIT 1
      `,
      [
        matchId
      ]
    );


  return (
    rows[0] ||
    null
  );
}


// ==================================================
// SAVE / CHANGE PREDICTION
// ==================================================

export async function saveTiPrediction({
  userId,
  matchId,
  teamId
}) {
  await q(
    `
      INSERT INTO ti_predictions (
        user_id,
        match_id,
        predicted_team_id
      )

      VALUES (
        ?,
        ?,
        ?
      )

      ON DUPLICATE KEY UPDATE

        predicted_team_id =
          VALUES(predicted_team_id),

        updated_at =
          CURRENT_TIMESTAMP
    `,
    [
      userId,
      matchId,
      teamId
    ]
  );
}


// ==================================================
// USER PREDICTIONS
//
// Сам прогноз и его правильность видны всегда.
// earned_points / earned_bonus_rub становятся > 0
// только после подтверждения регистрации админом.
// ==================================================

export async function getUserPredictions(
  userId
) {
  return q(
    `
      SELECT

        p.id,
        p.user_id,
        p.match_id,
        p.predicted_team_id,
        p.created_at,
        p.updated_at,

        m.source_match_id,

        m.team_a_id,
        m.team_a_name,

        m.team_b_id,
        m.team_b_name,

        m.start_time,
        m.status,
        m.score_a,
        m.score_b,
        m.winner_team_id,
        m.reward_group,
        m.points,
        m.bonus_rub,

        u.phone_verified,
        u.registration_status,
        u.rating_group,


        CASE
          WHEN
            m.status = 'finished'
            AND p.predicted_team_id =
              m.winner_team_id
          THEN 1

          WHEN
            m.status = 'finished'
          THEN 0

          ELSE NULL
        END AS is_correct,


        CASE
          WHEN
            u.is_active = 1
            AND u.phone_verified = 1
            AND u.registration_status =
              'approved'
            AND m.status = 'finished'
            AND p.predicted_team_id =
              m.winner_team_id
          THEN m.points

          ELSE 0
        END AS earned_points,


        CASE
          WHEN
            u.is_active = 1
            AND u.phone_verified = 1
            AND u.registration_status =
              'approved'
            AND u.rating_group =
              'main'
            AND m.status = 'finished'
            AND p.predicted_team_id =
              m.winner_team_id
          THEN m.bonus_rub

          ELSE 0
        END AS earned_bonus_rub


      FROM ti_predictions p

      JOIN ti_matches m
        ON m.id =
          p.match_id

      JOIN ti_users u
        ON u.id =
          p.user_id

      WHERE
        p.user_id = ?

      ORDER BY
        m.start_time DESC,
        m.id DESC
    `,
    [
      userId
    ]
  );
}


// ==================================================
// RATING
//
// В рейтинг попадают:
// - активные пользователи
// - подтвердившие свой Telegram-телефон
// - pending_admin и approved
//
// pending_admin показывается анонимно.
// Баллы/bonus_rub у pending_admin остаются 0.
//
// rejected в рейтинг не попадает.
//
// После approve ранее сделанные правильные прогнозы
// автоматически начинают учитываться.
// ==================================================

export async function getTiRating() {
  return q(
    `
      SELECT

        u.id,
        u.telegram_id,

        u.registration_status,
        u.rating_name_mode,

        u.gizmo_match_status,
        u.gizmo_user_id,
        u.gizmo_username,
        u.gizmo_first_name,
        u.gizmo_last_name,


        COALESCE(
          SUM(
            CASE
              WHEN
                u.registration_status =
                  'approved'
                AND m.status =
                  'finished'
                AND p.predicted_team_id =
                  m.winner_team_id
              THEN m.points
              ELSE 0
            END
          ),
          0
        ) AS score,


        COALESCE(
          SUM(
            CASE
              WHEN
                u.registration_status =
                  'approved'
                AND m.status =
                  'finished'
                AND p.predicted_team_id =
                  m.winner_team_id
              THEN m.bonus_rub
              ELSE 0
            END
          ),
          0
        ) AS bonus_rub,


        COALESCE(
          SUM(
            CASE
              WHEN
                u.registration_status =
                  'approved'
                AND m.status =
                  'finished'
                AND p.predicted_team_id =
                  m.winner_team_id
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS correct_predictions,


        COALESCE(
          SUM(
            CASE
              WHEN
                m.status =
                  'finished'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS finished_predictions,


        COUNT(
          p.id
        ) AS total_predictions


      FROM ti_users u

      LEFT JOIN ti_predictions p
        ON p.user_id =
          u.id

      LEFT JOIN ti_matches m
        ON m.id =
          p.match_id

      WHERE
        u.is_active = 1

        AND u.phone_verified = 1

        AND u.rules_accepted_at IS NOT NULL

        AND u.privacy_consent_at IS NOT NULL

        AND u.rating_name_mode
          IN (
            'name',
            'pseudonym'
          )

        AND u.privacy_withdrawal_requested_at IS NULL

        AND u.registration_status
          IN (
            'pending_admin',
            'approved'
          )

        AND u.rating_group =
          'main'

      GROUP BY
        u.id,
        u.telegram_id,
        u.registration_status,
        u.rating_name_mode,
        u.gizmo_match_status,
        u.gizmo_user_id,
        u.gizmo_username,
        u.gizmo_first_name,
        u.gizmo_last_name,
        u.created_at

      ORDER BY
        score DESC,
        correct_predictions DESC,
        u.created_at ASC,
        u.id ASC
    `
  );
}


// ==================================================
// ONE USER STATS
//
// Строка возвращается и для pending/rejected.
// Баллы и рубли у них = 0 до approve.
// ==================================================

export async function getTiUserStats(
  userId
) {
  const rows =
    await q(
      `
        SELECT

          u.id,
          u.telegram_id,
          u.username,
          u.first_name,
          u.phone_verified,
          u.registration_status,
          u.rating_group,


          COALESCE(
            SUM(
              CASE
                WHEN
                  u.is_active = 1
                  AND u.phone_verified = 1
                  AND u.registration_status =
                    'approved'
                  AND m.status = 'finished'
                  AND p.predicted_team_id =
                    m.winner_team_id
                THEN m.points
                ELSE 0
              END
            ),
            0
          ) AS score,


          COALESCE(
            SUM(
              CASE
                WHEN
                  u.is_active = 1
                  AND u.phone_verified = 1
                  AND u.registration_status =
                    'approved'
                  AND u.rating_group =
                    'main'
                  AND m.status = 'finished'
                  AND p.predicted_team_id =
                    m.winner_team_id
                THEN m.bonus_rub
                ELSE 0
              END
            ),
            0
          ) AS bonus_rub,


          COALESCE(
            SUM(
              CASE
                WHEN
                  m.status = 'finished'
                  AND p.predicted_team_id =
                    m.winner_team_id
                THEN 1
                ELSE 0
              END
            ),
            0
          ) AS correct_predictions,


          COALESCE(
            SUM(
              CASE
                WHEN
                  m.status = 'finished'
                THEN 1
                ELSE 0
              END
            ),
            0
          ) AS finished_predictions,


          COUNT(
            p.id
          ) AS total_predictions


        FROM ti_users u

        LEFT JOIN ti_predictions p
          ON p.user_id =
            u.id

        LEFT JOIN ti_matches m
          ON m.id =
            p.match_id

        WHERE
          u.id = ?

        GROUP BY
          u.id,
          u.telegram_id,
          u.username,
          u.first_name,
          u.phone_verified,
          u.registration_status,
          u.rating_group

        LIMIT 1
      `,
      [
        userId
      ]
    );


  return (
    rows[0] ||
    null
  );
}

// ==================================================
// RATING GROUPS
//
// main               = основной конкурс
// out_of_competition = вне конкурса
//
// Обе группы могут делать прогнозы.
//
// main:
// - участвует в основном рейтинге
// - получает конкурсные баллы
// - получает бонусные рубли
//
// out_of_competition:
// - имеет отдельный рейтинг
// - получает баллы только для рейтинга "вне конкурса"
// - не получает бонусные рубли
// - не влияет на места основного конкурса
// ==================================================

export const TI_RATING_GROUPS =
  new Set([
    'main',
    'out_of_competition'
  ]);


export async function setTiUserRatingGroup({
  userId,
  ratingGroup
}) {
  const group =
    String(
      ratingGroup || ''
    ).trim();


  if (
    !TI_RATING_GROUPS.has(
      group
    )
  ) {
    throw new Error(
      `Unknown TI rating group: ${group}`
    );
  }


  const result =
    await q(
      `
        UPDATE ti_users

        SET
          rating_group = ?

        WHERE id = ?
      `,
      [
        group,
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


export async function getTiUsersForRatingGroups() {
  return q(
    `
      SELECT
        id,
        telegram_id,
        username,
        first_name,
        last_name,

        phone_verified,
        registration_status,

        gizmo_match_status,
        gizmo_user_id,
        gizmo_username,
        gizmo_first_name,
        gizmo_last_name,

        rating_group

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

      ORDER BY
        CASE
          WHEN rating_group =
            'out_of_competition'
          THEN 1
          ELSE 2
        END,

        id ASC
    `
  );
}


// ==================================================
// OUT OF COMPETITION RATING
//
// pending_admin:
// - остаётся в списке анонимно
// - score = 0
//
// approved:
// - считаются правильные прогнозы и баллы
// - bonus_rub всегда 0
// ==================================================

export async function getTiOutOfCompetitionRating() {
  return q(
    `
      SELECT

        u.id,
        u.telegram_id,

        u.registration_status,
        u.rating_name_mode,

        u.gizmo_match_status,
        u.gizmo_user_id,
        u.gizmo_username,
        u.gizmo_first_name,
        u.gizmo_last_name,


        COALESCE(
          SUM(
            CASE
              WHEN
                u.registration_status =
                  'approved'
                AND m.status =
                  'finished'
                AND p.predicted_team_id =
                  m.winner_team_id
              THEN m.points
              ELSE 0
            END
          ),
          0
        ) AS score,


        0 AS bonus_rub,


        COALESCE(
          SUM(
            CASE
              WHEN
                u.registration_status =
                  'approved'
                AND m.status =
                  'finished'
                AND p.predicted_team_id =
                  m.winner_team_id
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS correct_predictions,


        COALESCE(
          SUM(
            CASE
              WHEN
                m.status =
                  'finished'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS finished_predictions,


        COUNT(
          p.id
        ) AS total_predictions


      FROM ti_users u

      LEFT JOIN ti_predictions p
        ON p.user_id =
          u.id

      LEFT JOIN ti_matches m
        ON m.id =
          p.match_id

      WHERE
        u.is_active = 1

        AND u.phone_verified = 1

        AND u.rules_accepted_at IS NOT NULL

        AND u.privacy_consent_at IS NOT NULL

        AND u.rating_name_mode
          IN (
            'name',
            'pseudonym'
          )

        AND u.privacy_withdrawal_requested_at IS NULL

        AND u.registration_status
          IN (
            'pending_admin',
            'approved'
          )

        AND u.rating_group =
          'out_of_competition'

        GROUP BY
          u.id,
          u.telegram_id,
          u.registration_status,
          u.rating_name_mode,
          u.gizmo_match_status,
          u.gizmo_user_id,
          u.gizmo_username,
          u.gizmo_first_name,
          u.gizmo_last_name,
          u.created_at

        ORDER BY
          score DESC,
          correct_predictions DESC,
          u.created_at ASC,
          u.id ASC
    `
  );
}

// ==================================================
// LEGAL CONSENTS
// ==================================================

export async function acceptTiRules({
  telegramId,
  version
}) {
  const result =
    await q(
      `
        UPDATE ti_users
        SET
          rules_version = ?,
          rules_accepted_at =
            CURRENT_TIMESTAMP
        WHERE telegram_id = ?
          AND privacy_withdrawal_requested_at
            IS NULL
      `,
      [
        version,
        telegramId
      ]
    );

  return {
    changed:
      Number(
        result?.affectedRows || 0
      ) > 0
  };
}


export async function acceptTiPrivacyConsent({
  telegramId,
  version
}) {
  const result =
    await q(
      `
        UPDATE ti_users
        SET
          privacy_consent_version = ?,
          privacy_consent_at =
            CURRENT_TIMESTAMP
        WHERE telegram_id = ?
          AND privacy_withdrawal_requested_at
            IS NULL
      `,
      [
        version,
        telegramId
      ]
    );

  return {
    changed:
      Number(
        result?.affectedRows || 0
      ) > 0
  };
}


export async function setTiRatingNameMode({
  telegramId,
  mode,
  version
}) {
  const normalizedMode =
    String(
      mode || ''
    ).trim();

  if (
    normalizedMode !== 'name' &&
    normalizedMode !== 'pseudonym'
  ) {
    throw new Error(
      `Unknown TI rating name mode: ${normalizedMode}`
    );
  }

  const result =
    await q(
      `
        UPDATE ti_users
        SET
          rating_name_mode = ?,
          rating_publication_version = ?,
          rating_publication_decided_at =
            CURRENT_TIMESTAMP
        WHERE telegram_id = ?
          AND privacy_withdrawal_requested_at
            IS NULL
      `,
      [
        normalizedMode,
        version,
        telegramId
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
// PRIVACY WITHDRAWAL
// ==================================================

export async function requestTiPrivacyWithdrawal({
  telegramId,
  channel = 'telegram_bot'
}) {
  const result =
    await q(
      `
        UPDATE ti_users

        SET
          privacy_withdrawal_requested_at =
            COALESCE(
              privacy_withdrawal_requested_at,
              CURRENT_TIMESTAMP
            ),

          privacy_withdrawal_channel =
            COALESCE(
              privacy_withdrawal_channel,
              ?
            )

        WHERE telegram_id = ?
      `,
      [
        channel,
        telegramId
      ]
    );


  return {
    changed:
      Number(
        result?.affectedRows || 0
      ) > 0
  };
}

