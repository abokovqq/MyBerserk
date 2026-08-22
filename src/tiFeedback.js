import { pool } from './db.js';

import {
  tiTg,
  tiSend
} from './tiTg.js';


// ============================================================
// CONFIG
// ============================================================

export const TI_FEEDBACK_SURVEY_CODE =
  'ti2026';


// ============================================================
// ВАРИАНТЫ ОТВЕТОВ
// ============================================================

export const TI_FEEDBACK_OPTIONS = {

  overall: {
    great: '🔥 Отлично',
    good: '👍 Хорошо',
    normal: '😐 Нормально',
    bad: '👎 Не понравилось'
  },

  liked: {
    predictions: '🎯 Прогнозы',
    prizes: '💰 Призы',
    bot: '🤖 Бот',
    bracket: '🖼 Сетка TI'
  },

  missed_reason: {
    no_time: '⏰ Не успевал',
    bot: '🤖 Было неудобно в боте',
    not_follow: '🎮 Не следил за всеми матчами',
    no_chance: '🏆 Не видел смысла бороться за место',
    other: '🤷 Другая причина'
  },

  inconvenient: {
    all_good: '✅ Всё удобно',
    registration: '📝 Регистрация',
    bets: '🎯 Ставки',
    rating: '🏆 Рейтинг',
    notifications: '🔔 Уведомления',
    rules: '📜 Правила',
    schedule: '🗓 Расписание'
  },

  next_event: {
    yes: '🔥 Точно да',
    probably: '👍 Скорее да',
    maybe: '🤔 Возможно',
    no: '❌ Нет'
  }

};


// ============================================================
// ПРОВЕРКА ОТВЕТА
// ============================================================

function isValidFeedbackValue(
  field,
  value
) {
  const options =
    TI_FEEDBACK_OPTIONS[field];

  if (!options) {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(
    options,
    value
  );
}


// ============================================================
// ПОЛЬЗОВАТЕЛЬ ПО TELEGRAM ID
// ============================================================

export async function getTiFeedbackUserByTelegramId(
  telegramId
) {
  const [rows] =
    await pool.query(
      `
        SELECT
          id,
          telegram_id,
          username,
          first_name,
          last_name,
          phone_verified,
          registration_status,
          rating_group,
          is_active
        FROM ti_users
        WHERE
          telegram_id = ?
        LIMIT 1
      `,
      [
        telegramId
      ]
    );

  return rows[0] || null;
}


// ============================================================
// ПОЛЬЗОВАТЕЛЬ ПО USER ID
// ============================================================

export async function getTiFeedbackUserById(
  userId
) {
  const [rows] =
    await pool.query(
      `
        SELECT
          id,
          telegram_id,
          username,
          first_name,
          last_name,
          phone_verified,
          registration_status,
          rating_group,
          is_active
        FROM ti_users
        WHERE
          id = ?
        LIMIT 1
      `,
      [
        userId
      ]
    );

  return rows[0] || null;
}


// ============================================================
// ДОПУЩЕН ЛИ К ОПРОСУ
// ============================================================

export function canUseTiFeedback(
  user
) {
  return Boolean(
    user &&
    Number(user.is_active) === 1 &&
    Number(user.phone_verified) === 1 &&
    user.registration_status === 'approved' &&
    user.telegram_id
  );
}


// ============================================================
// DISPLAY NAME ДЛЯ АДМИНСКИХ СПИСКОВ
// ============================================================

export function getTiFeedbackDisplayName(
  user
) {
  const username =
    String(
      user?.username || ''
    ).trim();

  if (username) {
    return `@${username}`;
  }

  return `Telegram ID ${user?.telegram_id || '—'}`;
}


// ============================================================
// ПОЛУЧИТЬ ОПРОС ПОЛЬЗОВАТЕЛЯ
// ============================================================

export async function getTiFeedback(
  userId
) {
  const [rows] =
    await pool.query(
      `
        SELECT *
        FROM ti_feedback
        WHERE
          survey_code = ?
          AND user_id = ?
        LIMIT 1
      `,
      [
        TI_FEEDBACK_SURVEY_CODE,
        userId
      ]
    );

  return rows[0] || null;
}


// ============================================================
// СОЗДАТЬ СТРОКУ ОПРОСА
// ============================================================

export async function ensureTiFeedback(
  userId
) {
  await pool.query(
    `
      INSERT INTO ti_feedback (
        survey_code,
        user_id
      )
      VALUES (
        ?,
        ?
      )

      ON DUPLICATE KEY UPDATE
        user_id = VALUES(user_id)
    `,
    [
      TI_FEEDBACK_SURVEY_CODE,
      userId
    ]
  );

  return getTiFeedback(
    userId
  );
}


// ============================================================
// ОТМЕТИТЬ ОТПРАВКУ ПРИГЛАШЕНИЯ
// ============================================================

export async function markTiFeedbackInviteSent(
  userId
) {
  await ensureTiFeedback(
    userId
  );

  await pool.query(
    `
      UPDATE ti_feedback
      SET
        invite_sent_at = NOW()
      WHERE
        survey_code = ?
        AND user_id = ?
    `,
    [
      TI_FEEDBACK_SURVEY_CODE,
      userId
    ]
  );
}


// ============================================================
// НАЧАТЬ ОПРОС
// ============================================================

export async function startTiFeedback(
  userId
) {
  await ensureTiFeedback(
    userId
  );

  await pool.query(
    `
      UPDATE ti_feedback
      SET
        started_at =
          COALESCE(
            started_at,
            NOW()
          )
      WHERE
        survey_code = ?
        AND user_id = ?
    `,
    [
      TI_FEEDBACK_SURVEY_CODE,
      userId
    ]
  );

  return getTiFeedback(
    userId
  );
}


// ============================================================
// СОХРАНИТЬ ОТВЕТ
// ============================================================

export async function saveTiFeedbackAnswer({
  userId,
  field,
  value
}) {
  const allowedFields =
    new Set([
      'overall',
      'liked',
      'missed_reason',
      'inconvenient',
      'next_event'
    ]);

  if (
    !allowedFields.has(field)
  ) {
    throw new Error(
      `TI feedback: unknown field "${field}"`
    );
  }

  if (
    !isValidFeedbackValue(
      field,
      value
    )
  ) {
    throw new Error(
      `TI feedback: invalid value "${value}" for "${field}"`
    );
  }

  await startTiFeedback(
    userId
  );

  const sql = `
    UPDATE ti_feedback
    SET
      ${field} = ?
    WHERE
      survey_code = ?
      AND user_id = ?
  `;

  await pool.query(
    sql,
    [
      value,
      TI_FEEDBACK_SURVEY_CODE,
      userId
    ]
  );

  return getTiFeedback(
    userId
  );
}


// ============================================================
// ЗАВЕРШИТЬ ОПРОС
// ============================================================

export async function completeTiFeedback(
  userId
) {
  await ensureTiFeedback(
    userId
  );

  await pool.query(
    `
      UPDATE ti_feedback
      SET
        completed_at =
          COALESCE(
            completed_at,
            NOW()
          )
      WHERE
        survey_code = ?
        AND user_id = ?
    `,
    [
      TI_FEEDBACK_SURVEY_CODE,
      userId
    ]
  );

  return getTiFeedback(
    userId
  );
}


// ============================================================
// ПРОШЁЛ ЛИ ПОЛЬЗОВАТЕЛЬ ОПРОС
// ============================================================

export async function hasCompletedTiFeedback(
  userId
) {
  const feedback =
    await getTiFeedback(
      userId
    );

  return Boolean(
    feedback?.completed_at
  );
}


// ============================================================
// КОМУ МОЖНО ОТПРАВЛЯТЬ ОПРОС
// ============================================================

export async function getTiFeedbackRecipients() {
  const [rows] =
    await pool.query(
      `
        SELECT
          u.id,
          u.telegram_id,
          u.username,
          u.first_name,
          u.last_name,
          u.rating_group,

          f.invite_sent_at,
          f.started_at,
          f.completed_at

        FROM ti_users u

        LEFT JOIN ti_feedback f
          ON f.user_id = u.id
          AND f.survey_code = ?

        WHERE
          u.is_active = 1
          AND u.phone_verified = 1
          AND u.registration_status = 'approved'
          AND u.telegram_id IS NOT NULL

        ORDER BY
          u.id ASC
      `,
      [
        TI_FEEDBACK_SURVEY_CODE
      ]
    );

  return rows;
}


// ============================================================
// ПОЛЬЗОВАТЕЛЬ ДЕЛАЛ ПРОГНОЗЫ НЕ НА ВСЕ МАТЧИ?
// ============================================================

export async function hasTiFeedbackMissedMatches(
  userId
) {
  const [rows] =
    await pool.query(
      `
        SELECT
          COUNT(
            DISTINCT p.match_id
          ) AS predictions_count

        FROM ti_predictions p

        JOIN ti_matches m
          ON m.id = p.match_id

        WHERE
          p.user_id = ?
          AND m.league_id = 19719
          AND m.status = 'finished'
          AND m.team_a_id IS NOT NULL
          AND m.team_b_id IS NOT NULL
      `,
      [
        userId
      ]
    );

  const predictionsCount =
    Number(
      rows[0]?.predictions_count || 0
    );


  const [matchRows] =
    await pool.query(
      `
        SELECT
          COUNT(*) AS matches_count

        FROM ti_matches

        WHERE
          league_id = 19719
          AND status = 'finished'
          AND team_a_id IS NOT NULL
          AND team_b_id IS NOT NULL
      `
    );

  const matchesCount =
    Number(
      matchRows[0]?.matches_count || 0
    );

  return {
    missed:
      matchesCount > 0 &&
      predictionsCount < matchesCount,

    predictions_count:
      predictionsCount,

    matches_count:
      matchesCount,

    missed_count:
      Math.max(
        0,
        matchesCount -
        predictionsCount
      )
  };
}


// ============================================================
// ОБЩАЯ СТАТИСТИКА ОПРОСА
// ============================================================

export async function getTiFeedbackSummary() {
  const [rows] =
    await pool.query(
      `
        SELECT
          COUNT(*) AS invited_rows,

          SUM(
            invite_sent_at IS NOT NULL
          ) AS invites_sent,

          SUM(
            started_at IS NOT NULL
          ) AS started,

          SUM(
            completed_at IS NOT NULL
          ) AS completed

        FROM ti_feedback

        WHERE
          survey_code = ?
      `,
      [
        TI_FEEDBACK_SURVEY_CODE
      ]
    );

  return rows[0] || {
    invited_rows: 0,
    invites_sent: 0,
    started: 0,
    completed: 0
  };
}


// ============================================================
// РАСПРЕДЕЛЕНИЕ ОТВЕТОВ
// ============================================================

export async function getTiFeedbackAnswerStats(
  field
) {
  const allowedFields =
    new Set([
      'overall',
      'liked',
      'missed_reason',
      'inconvenient',
      'next_event'
    ]);

  if (
    !allowedFields.has(field)
  ) {
    throw new Error(
      `TI feedback stats: unknown field "${field}"`
    );
  }

  const [rows] =
    await pool.query(
      `
        SELECT
          ${field} AS value,
          COUNT(*) AS total

        FROM ti_feedback

        WHERE
          survey_code = ?
          AND ${field} IS NOT NULL

        GROUP BY
          ${field}

        ORDER BY
          total DESC
      `,
      [
        TI_FEEDBACK_SURVEY_CODE
      ]
    );

  return rows;
}


// ============================================================
// TELEGRAM — РЕДАКТИРОВАНИЕ ТЕКУЩЕЙ КАРТОЧКИ
// ============================================================

async function editTiFeedbackMessage(
  query,
  text,
  keyboard = []
) {
  const chatId =
    query.message?.chat?.id;

  const messageId =
    query.message?.message_id;

  if (
    !chatId ||
    !messageId
  ) {
    return;
  }

  try {
    await tiTg(
      'editMessageText',
      {
        chat_id:
          chatId,

        message_id:
          messageId,

        text,

        parse_mode:
          'HTML',

        disable_web_page_preview:
          true,

        reply_markup: {
          inline_keyboard:
            keyboard
        }
      }
    );

  } catch (err) {
    const message =
      String(
        err?.message ||
        err
      );

    if (
      message.includes(
        'message is not modified'
      )
    ) {
      return;
    }

    throw err;
  }
}


// ============================================================
// ВСТУПИТЕЛЬНОЕ СООБЩЕНИЕ
// ============================================================

export async function showTiFeedbackIntro(
  chatId
) {
  return tiSend(
    chatId,

    `🏆 <b>Спасибо за участие в конкурсе The International 2026!</b>

Спасибо, что делали прогнозы и следили за турниром вместе с нами ❤️

Мы хотим сделать следующие конкурсы ещё интереснее и удобнее.

Поэтому просим пройти <b>короткий опрос — это займёт меньше минуты</b>.

Писать ничего не нужно — только нажимать кнопки.

Ваши ответы действительно помогут нам улучшить следующий конкурс.`,

    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                '👇 Начать опрос',

              callback_data:
                'ti:fb:start'
            }
          ]
        ]
      }
    }
  );
}


// ============================================================
// ОТПРАВИТЬ ПРИГЛАШЕНИЕ ОДНОМУ USER_ID
// ============================================================

export async function sendTiFeedbackInviteToUserId(
  userId
) {
  const user =
    await getTiFeedbackUserById(
      userId
    );

  if (
    !canUseTiFeedback(user)
  ) {
    throw new Error(
      `TI feedback: user_id=${userId} is not an approved participant`
    );
  }

  const feedback =
    await getTiFeedback(
      user.id
    );

  if (
    feedback?.completed_at
  ) {
    return {
      sent: false,
      reason: 'completed',
      user
    };
  }

  await showTiFeedbackIntro(
    user.telegram_id
  );

  // Отмечаем только ПОСЛЕ успешного sendMessage.
  await markTiFeedbackInviteSent(
    user.id
  );

  return {
    sent: true,
    user
  };
}


// ============================================================
// ВОПРОС 1
// ============================================================

async function showTiFeedbackQuestion1(
  query
) {
  await editTiFeedbackMessage(
    query,

    `🎮 <b>1/5. Как тебе конкурс TI в целом?</b>`,

    [
      [
        {
          text:
            '🔥 Отлично',
          callback_data:
            'ti:fb:q1:great'
        },
        {
          text:
            '👍 Хорошо',
          callback_data:
            'ti:fb:q1:good'
        }
      ],

      [
        {
          text:
            '😐 Нормально',
          callback_data:
            'ti:fb:q1:normal'
        },
        {
          text:
            '👎 Не понравилось',
          callback_data:
            'ti:fb:q1:bad'
        }
      ]
    ]
  );
}


// ============================================================
// ВОПРОС 2
// ============================================================

async function showTiFeedbackQuestion2(
  query
) {
  await editTiFeedbackMessage(
    query,

    `❤️ <b>2/5. Что понравилось больше всего?</b>`,

    [
      [
        {
          text:
            '🎯 Прогнозы',
          callback_data:
            'ti:fb:q2:predictions'
        },
        {
          text:
            '💰 Призы',
          callback_data:
            'ti:fb:q2:prizes'
        }
      ],

      [
        {
          text:
            '🤖 Бот',
          callback_data:
            'ti:fb:q2:bot'
        },
        {
          text:
            '🖼 Сетка TI',
          callback_data:
            'ti:fb:q2:bracket'
        }
      ]
    ]
  );
}


// ============================================================
// ВОПРОС 3
// Только если прогнозы были не на все матчи
// ============================================================

async function showTiFeedbackQuestion3(
  query
) {
  await editTiFeedbackMessage(
    query,

    `🎯 <b>3/5. Почему ты делал прогнозы не на все матчи?</b>`,

    [
      [
        {
          text:
            '⏰ Не успевал',
          callback_data:
            'ti:fb:q3:no_time'
        }
      ],

      [
        {
          text:
            '🤖 Было неудобно в боте',
          callback_data:
            'ti:fb:q3:bot'
        }
      ],

      [
        {
          text:
            '🎮 Не следил за всеми матчами',
          callback_data:
            'ti:fb:q3:not_follow'
        }
      ],

      [
        {
          text:
            '🏆 Не видел смысла бороться за место',
          callback_data:
            'ti:fb:q3:no_chance'
        }
      ],

      [
        {
          text:
            '🤷 Другая причина',
          callback_data:
            'ti:fb:q3:other'
        }
      ]
    ]
  );
}


// ============================================================
// ВОПРОС 4
// Задаётся ВСЕМ
// ============================================================

async function showTiFeedbackQuestion4(
  query
) {
  await editTiFeedbackMessage(
    query,

    `⚙️ <b>Что было самым неудобным?</b>`,

    [
      [
        {
          text:
            '✅ Всё удобно',
          callback_data:
            'ti:fb:q4:all_good'
        }
      ],

      [
        {
          text:
            '📝 Регистрация',
          callback_data:
            'ti:fb:q4:registration'
        },
        {
          text:
            '🎯 Ставки',
          callback_data:
            'ti:fb:q4:bets'
        }
      ],

      [
        {
          text:
            '🏆 Рейтинг',
          callback_data:
            'ti:fb:q4:rating'
        },
        {
          text:
            '🔔 Уведомления',
          callback_data:
            'ti:fb:q4:notifications'
        }
      ],

      [
        {
          text:
            '📜 Правила',
          callback_data:
            'ti:fb:q4:rules'
        },
        {
          text:
            '🗓 Расписание',
          callback_data:
            'ti:fb:q4:schedule'
        }
      ]
    ]
  );
}


// ============================================================
// ВОПРОС 5
// ============================================================

async function showTiFeedbackQuestion5(
  query
) {
  await editTiFeedbackMessage(
    query,

    `🏆 <b>Будешь участвовать в следующем таком конкурсе?</b>`,

    [
      [
        {
          text:
            '🔥 Точно да',
          callback_data:
            'ti:fb:q5:yes'
        },
        {
          text:
            '👍 Скорее да',
          callback_data:
            'ti:fb:q5:probably'
        }
      ],

      [
        {
          text:
            '🤔 Возможно',
          callback_data:
            'ti:fb:q5:maybe'
        },
        {
          text:
            '❌ Нет',
          callback_data:
            'ti:fb:q5:no'
        }
      ]
    ]
  );
}


// ============================================================
// ОПРОС ЗАВЕРШЁН
// ============================================================

async function showTiFeedbackFinished(
  query
) {
  await editTiFeedbackMessage(
    query,

    `✅ <b>Спасибо за обратную связь!</b>

Ответы сохранены ❤️

Это поможет нам сделать следующий конкурс BERSERK ещё удобнее и интереснее.`,

    []
  );
}


// ============================================================
// ПОКАЗАТЬ СЛЕДУЮЩИЙ НЕОТВЕЧЕННЫЙ ВОПРОС
// ============================================================

async function showNextTiFeedbackQuestion(
  query,
  userId
) {
  const feedback =
    await getTiFeedback(
      userId
    );

  if (
    feedback?.completed_at
  ) {
    await showTiFeedbackFinished(
      query
    );

    return;
  }


  if (
    !feedback?.overall
  ) {
    await showTiFeedbackQuestion1(
      query
    );

    return;
  }


  if (
    !feedback?.liked
  ) {
    await showTiFeedbackQuestion2(
      query
    );

    return;
  }


  const missed =
    await hasTiFeedbackMissedMatches(
      userId
    );


  if (
    missed.missed &&
    !feedback?.missed_reason
  ) {
    await showTiFeedbackQuestion3(
      query
    );

    return;
  }


  if (
    !feedback?.inconvenient
  ) {
    await showTiFeedbackQuestion4(
      query
    );

    return;
  }


  if (
    !feedback?.next_event
  ) {
    await showTiFeedbackQuestion5(
      query
    );

    return;
  }


  await completeTiFeedback(
    userId
  );

  await showTiFeedbackFinished(
    query
  );
}


// ============================================================
// CALLBACK HANDLER
//
// В tiBotWorker потом будет только:
//
// if (data?.startsWith('ti:fb:')) {
//   await handleTiFeedbackCallback(query, data);
//   return;
// }
//
// ============================================================

export async function handleTiFeedbackCallback(
  query,
  data
) {
  const telegramId =
    query.from?.id;

  const chatId =
    query.message?.chat?.id;

  if (
    !telegramId ||
    !chatId
  ) {
    return;
  }


  // ----------------------------------------------------------
  // Проверяем регистрацию КАЖДЫЙ РАЗ
  // ----------------------------------------------------------

  const user =
    await getTiFeedbackUserByTelegramId(
      telegramId
    );

  if (
    !canUseTiFeedback(user)
  ) {
    await tiSend(
      chatId,
      '❌ Опрос доступен только зарегистрированным участникам конкурса.'
    );

    return;
  }


  // ----------------------------------------------------------
  // START
  // ----------------------------------------------------------

  if (
    data ===
      'ti:fb:start'
  ) {
    const feedback =
      await startTiFeedback(
        user.id
      );

    if (
      feedback?.completed_at
    ) {
      await showTiFeedbackFinished(
        query
      );

      return;
    }

    await showNextTiFeedbackQuestion(
      query,
      user.id
    );

    return;
  }


  // ----------------------------------------------------------
  // Q1
  // ----------------------------------------------------------

  if (
    data?.startsWith(
      'ti:fb:q1:'
    )
  ) {
    const value =
      data.split(':')[3];

    await saveTiFeedbackAnswer({
      userId:
        user.id,

      field:
        'overall',

      value
    });

    await showNextTiFeedbackQuestion(
      query,
      user.id
    );

    return;
  }


  // ----------------------------------------------------------
  // Q2
  // ----------------------------------------------------------

  if (
    data?.startsWith(
      'ti:fb:q2:'
    )
  ) {
    const value =
      data.split(':')[3];

    await saveTiFeedbackAnswer({
      userId:
        user.id,

      field:
        'liked',

      value
    });

    await showNextTiFeedbackQuestion(
      query,
      user.id
    );

    return;
  }


  // ----------------------------------------------------------
  // Q3
  // ----------------------------------------------------------

  if (
    data?.startsWith(
      'ti:fb:q3:'
    )
  ) {
    const value =
      data.split(':')[3];

    await saveTiFeedbackAnswer({
      userId:
        user.id,

      field:
        'missed_reason',

      value
    });

    await showNextTiFeedbackQuestion(
      query,
      user.id
    );

    return;
  }


  // ----------------------------------------------------------
  // Q4
  // ----------------------------------------------------------

  if (
    data?.startsWith(
      'ti:fb:q4:'
    )
  ) {
    const value =
      data.split(':')[3];

    await saveTiFeedbackAnswer({
      userId:
        user.id,

      field:
        'inconvenient',

      value
    });

    await showNextTiFeedbackQuestion(
      query,
      user.id
    );

    return;
  }


  // ----------------------------------------------------------
  // Q5
  // ----------------------------------------------------------

  if (
    data?.startsWith(
      'ti:fb:q5:'
    )
  ) {
    const value =
      data.split(':')[3];

    await saveTiFeedbackAnswer({
      userId:
        user.id,

      field:
        'next_event',

      value
    });

    await completeTiFeedback(
      user.id
    );

    await showTiFeedbackFinished(
      query
    );

    return;
  }


  console.log(
    new Date().toISOString(),
    '[TI FEEDBACK] unknown callback:',
    data
  );
}
