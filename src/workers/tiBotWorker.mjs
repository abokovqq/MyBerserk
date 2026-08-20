import '../env.js';

import path from 'node:path';
import {
  execFile
} from 'node:child_process';

import {
  fileURLToPath
} from 'node:url';

import {
  promisify
} from 'node:util';

import {
  access,
  readFile,
  writeFile
} from 'node:fs/promises';

import {
  createHash
} from 'node:crypto';


import {
  tiTg,
  tiSend,
  tiSendPhoto
} from '../tiTg.js';


import {
  registerTiUser,
  getTiUserByTelegramId,
  getOpenTiMatches,
  getTiMatch,
  saveTiPrediction,
  getUserPredictions,
  getTiRating,
  getTiOutOfCompetitionRating,
  setTiUserRatingGroup,
  getTiUsersForRatingGroups,
  acceptTiRules,
  acceptTiPrivacyConsent,
  setTiRatingNameMode,
  requestTiPrivacyWithdrawal
} from '../tiDb.js';


import {
  getTiAdminMatches,
  getTiAdminMatch,
  setTiAdminResult,
  resetTiAdminResult,
  resetTiAdminPlayoff
} from '../tiAdmin.js';


import {
  isTiAdminMode,
  enableTiAdminMode,
  disableTiAdminMode
} from '../tiAdminMode.js';


import {
  registerTiPhone,
  canTiUserPredict,
  getPendingTiRegistrations,
  getTiRegistration,
  approveTiRegistration,
  rejectTiRegistration,
  findTiGizmoUsersByPhone,
  refreshTiRegistration,
  refreshTiRegistrations
} from '../tiRegistration.js';


// ==================================================
// PATHS
// ==================================================

const __filename =
  fileURLToPath(
    import.meta.url
  );


const __dirname =
  path.dirname(
    __filename
  );


const PROJECT_DIR =
  path.resolve(
    __dirname,
    '../..'
  );


const BRACKET_SCRIPT =
  path.join(
    PROJECT_DIR,
    'src/utils/ti/generateTiBracket.mjs'
  );


const BRACKET_OUTPUT =
  path.join(
    PROJECT_DIR,
    'tmp/ti-bracket.png'
  );


const BRACKET_FINGERPRINT =
  path.join(
    PROJECT_DIR,
    'tmp/ti-bracket.sha256'
  );


// ==================================================
// LEGAL / CONSENT VERSIONS
// ==================================================

const TI_RULES_VERSION =
  '2026-08-19-v1';

const TI_PRIVACY_VERSION =
  '2026-08-19-v1';

const TI_PUBLICATION_VERSION =
  '2026-08-19-v1';


const execFileAsync =
  promisify(
    execFile
  );


let tiBracketGenerationPromise =
  null;


// ==================================================
// BRACKET CACHE
// ==================================================

function getTiBracketFingerprint(
  matches
) {
  const state =
    matches.map(
      match => ({
        id:
          Number(match.id) || null,

        source_match_id:
          Number(
            match.source_match_id
          ) || null,

        team_a_id:
          Number(
            match.team_a_id
          ) || null,

        team_a_name:
          match.team_a_name || null,

        team_b_id:
          Number(
            match.team_b_id
          ) || null,

        team_b_name:
          match.team_b_name || null,

        start_time:
          match.start_time
            ? new Date(
                match.start_time
              ).toISOString()
            : null,

        status:
          match.status || null,

        score_a:
          match.score_a ?? null,

        score_b:
          match.score_b ?? null,

        winner_team_id:
          Number(
            match.winner_team_id
          ) || null,

        betting_closed:
          Number(
            match.betting_closed
          ) || 0
      })
    );


  return createHash(
    'sha256'
  )
    .update(
      JSON.stringify(state)
    )
    .digest(
      'hex'
    );
}


async function readTiBracketFingerprint() {
  try {
    return (
      await readFile(
        BRACKET_FINGERPRINT,
        'utf8'
      )
    ).trim() || null;

  } catch {
    return null;
  }
}


async function tiBracketOutputExists() {
  try {
    await access(
      BRACKET_OUTPUT
    );

    return true;

  } catch {
    return false;
  }
}


async function generateTiBracketCache(
  fingerprint
) {
  await execFileAsync(
    process.execPath,

    [
      BRACKET_SCRIPT
    ],

    {
      cwd:
        PROJECT_DIR,

      timeout:
        60_000,

      maxBuffer:
        2 * 1024 * 1024
    }
  );


  await writeFile(
    BRACKET_FINGERPRINT,
    fingerprint + '\n',
    'utf8'
  );
}


async function ensureTiBracketCurrent({
  chatId = null
} = {}) {
  const matches =
    await getTiAdminMatches();


  const fingerprint =
    getTiBracketFingerprint(
      matches
    );


  const [
    savedFingerprint,
    outputExists
  ] =
    await Promise.all([
      readTiBracketFingerprint(),
      tiBracketOutputExists()
    ]);


  if (
    outputExists &&
    savedFingerprint ===
      fingerprint
  ) {
    return {
      generated: false,
      fingerprint
    };
  }


  // Если другой пользователь уже запустил
  // генерацию, не запускаем второй процесс.
  if (
    tiBracketGenerationPromise
  ) {
    await tiBracketGenerationPromise;


    const [
      afterFingerprint,
      afterOutputExists
    ] =
      await Promise.all([
        readTiBracketFingerprint(),
        tiBracketOutputExists()
      ]);


    if (
      afterOutputExists &&
      afterFingerprint ===
        fingerprint
    ) {
      return {
        generated: false,
        fingerprint
      };
    }
  }


  if (chatId) {
    await tiSend(
      chatId,
      '⏳ Обновляю актуальную сетку...'
    );
  }


  tiBracketGenerationPromise =
    generateTiBracketCache(
      fingerprint
    );


  try {
    await tiBracketGenerationPromise;

  } finally {
    tiBracketGenerationPromise =
      null;
  }


  return {
    generated: true,
    fingerprint
  };
}


// ==================================================
// POLLING OFFSET
// ==================================================

let offset = 0;


// ==================================================
// HELPERS
// ==================================================

function sleep(
  ms
) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


// ==================================================
// DATE
// ==================================================

function formatDateTime(
  date
) {
  return new Intl.DateTimeFormat(
    'ru-RU',
    {
      timeZone:
        'Europe/Moscow',

      day:
        '2-digit',

      month:
        '2-digit',

      hour:
        '2-digit',

      minute:
        '2-digit'
    }
  ).format(
    new Date(date)
  );
}


// ==================================================
// LEGAL / REGISTRATION CONSENTS
// ==================================================

function hasCurrentTiRules(
  user
) {
  return Boolean(
    user?.rules_accepted_at &&
    String(
      user.rules_version || ''
    ) === TI_RULES_VERSION
  );
}


function hasCurrentTiPrivacyConsent(
  user
) {
  return Boolean(
    user?.privacy_consent_at &&
    String(
      user.privacy_consent_version || ''
    ) === TI_PRIVACY_VERSION &&
    !user?.privacy_withdrawal_requested_at
  );
}


function hasTiRatingNameChoice(
  user
) {
  const mode =
    String(
      user?.rating_name_mode || ''
    );


  return Boolean(
    (
      mode === 'name' ||
      mode === 'pseudonym'
    ) &&
    user?.rating_publication_decided_at &&
    String(
      user.rating_publication_version || ''
    ) === TI_PUBLICATION_VERSION
  );
}


function hasCurrentTiLegalConsents(
  user
) {
  return Boolean(
    hasCurrentTiRules(user) &&
    hasCurrentTiPrivacyConsent(user) &&
    hasTiRatingNameChoice(user)
  );
}


async function showTiRulesPage(
  chatId,
  user,
  page = 1
) {
  const pageNumber =
    Number(page) || 1;


  if (pageNumber === 1) {
    await tiSend(
      chatId,

      `📜 <b>ПРАВИЛА КОНКУРСА — 1/3</b>
<b>BERSERK — THE INTERNATIONAL 2026</b>

<b>Организатор:</b>
ИП Суровцев Данил Романович
ИНН 773126145324
ОГРНИП 324774600720432
г. Москва, ул. Кастанаевская, д. 41, корп. 2
Компьютерный клуб BERSERK.

<b>1. Общие условия</b>
• Участие в конкурсе бесплатное.
• Участник не передаёт Организатору денежную ставку.
• Участники прогнозируют победителей матчей The International 2026.
• Конкурс завершается после Grand Final 23 августа 2026 года и получения окончательного результата матча.

<b>2. Регистрация</b>
• Регистрация проходит через @TI_berserkBot.
• Для прогнозов участник передаёт свой номер штатной кнопкой Telegram «Поделиться номером телефона».
• Бот принимает только контакт, принадлежащий самому Telegram-пользователю.
• Номер может сопоставляться с клиентской карточкой BERSERK/Gizmo.
• Окончательное подтверждение регистрации выполняет администратор клуба.
• До подтверждения прогнозы сохраняются, но конкурсные баллы и бонусные ₽ не учитываются.
• После подтверждения ранее сделанные прогнозы учитываются автоматически.`,

      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  'Далее →',
                callback_data:
                  'ti:rules:2'
              }
            ]
          ]
        }
      }
    );

    return;
  }


  if (pageNumber === 2) {
    await tiSend(
      chatId,

      `📜 <b>ПРАВИЛА КОНКУРСА — 2/3</b>

<b>3. Прогнозы</b>
• На каждый матч выбирается победитель из двух команд.
• До закрытия приёма прогноз можно изменить; учитывается последний сохранённый выбор.
• После начала матча или технического закрытия изменить прогноз нельзя.
• Временем подачи считается время успешного сохранения на сервере.
• При исправлении официального результата Организатор вправе выполнить автоматический перерасчёт.

<b>4. Баллы и бонусы</b>
Обычный матч:
🏆 1 балл
💰 50 бонусных ₽

Финал верхней сетки и финал нижней сетки:
🏆 2 балла
💰 200 бонусных ₽

Grand Final:
🏆 5 баллов
💰 500 бонусных ₽

За неправильный прогноз — 0 баллов и 0 бонусных ₽.

<b>5. Рейтинги</b>
🏆 <b>Основная</b> — участвует в конкурсе, получает баллы и бонусные ₽, претендует на призы.

🛡 <b>Вне конкурса</b> — может делать прогнозы и получает баллы в отдельном рейтинге, но:
• не влияет на конкурсные места;
• не получает конкурсные бонусные ₽;
• не претендует на призы.

Основная группа видит только конкурсный рейтинг.
Группа «Вне конкурса» видит оба рейтинга.`,

      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  '← Назад',
                callback_data:
                  'ti:rules:1'
              },
              {
                text:
                  'Далее →',
                callback_data:
                  'ti:rules:3'
              }
            ]
          ]
        }
      }
    );

    return;
  }


  const alreadyAccepted =
    hasCurrentTiRules(
      user
    );


  const finalKeyboard =
    alreadyAccepted
      ? [
          [
            {
              text:
                '← Назад',
              callback_data:
                'ti:rules:2'
            }
          ],
          [
            {
              text:
                '➡️ Продолжить',
              callback_data:
                'ti:legal:continue'
            }
          ]
        ]
      : [
          [
            {
              text:
                '← Назад',
              callback_data:
                'ti:rules:2'
            }
          ],
          [
            {
              text:
                '✅ Принимаю правила конкурса',
              callback_data:
                'ti:legal:rules:accept'
            }
          ],
          [
            {
              text:
                '❌ Не принимаю',
              callback_data:
                'ti:legal:rules:decline'
            }
          ]
        ];


  await tiSend(
    chatId,

    `📜 <b>ПРАВИЛА КОНКУРСА — 3/3</b>

<b>6. Призы</b>
После Grand Final призы получают участники основной группы, занявшие ТОП-3:

🥇 1 место — Arcana-предмет Dota 2 на выбор стоимостью до <b>3 000 ₽</b>.
🥈 2 место — Arcana-предмет Dota 2 на выбор стоимостью до <b>2 500 ₽</b>.
🥉 3 место — Arcana-предмет Dota 2 на выбор стоимостью до <b>2 000 ₽</b>.

Предмет выбирается из доступных на торговой площадке на момент приобретения Организатором.
Если цена выше лимита — выбирается другой предмет.
Разница между лимитом и фактической ценой деньгами, бонусами или дополнительными предметами не компенсируется.
Денежный эквивалент приза не выплачивается.

<b>7. Определение мест</b>
1) сумма баллов;
2) при равенстве — количество правильных прогнозов;
3) при полном равенстве — выше участник, зарегистрированный раньше.

<b>8. Технические условия</b>
Организатор вправе исправлять технические ошибки подсчёта и учитывать официальные изменения расписания, сетки и результатов турнира.

Участник может быть исключён за использование чужого телефона, несколько аккаунтов для получения преимущества, попытку изменить прогноз после закрытия либо вмешательство в работу системы.

Нажатие «Принимаю правила конкурса» подтверждает принятие Правил и <b>не является</b> согласием на обработку персональных данных. Согласие на ПД запрашивается отдельно.

Версия правил: <code>${TI_RULES_VERSION}</code>`,

    {
      reply_markup: {
        inline_keyboard:
          finalKeyboard
      }
    }
  );
}


async function showTiPrivacyConsent(
  chatId
) {
  await tiSend(
    chatId,

    `🔐 <b>СОГЛАСИЕ НА ОБРАБОТКУ ПЕРСОНАЛЬНЫХ ДАННЫХ</b>

<b>Оператор:</b>
ИП Суровцев Данил Романович
ИНН 773126145324
ОГРНИП 324774600720432
г. Москва, ул. Кастанаевская, д. 41, корп. 2
Компьютерный клуб BERSERK.

Для регистрации и проведения конкурса могут сохраняться и обрабатываться:

• Telegram ID, username, имя и фамилия Telegram-аккаунта;
• номер телефона и его нормализованное техническое представление;
• факт подтверждения принадлежности Telegram-контакта;
• данные карточки BERSERK/Gizmo: внутренний ID, username, имя, фамилия и результат сопоставления;
• статус регистрации и подтверждения администратором;
• группа рейтинга;
• прогнозы, выбранные команды, даты и время создания/изменения;
• результаты прогнозов, количество правильных прогнозов, баллы и бонусные ₽;
• сведения о принятии правил и согласий;
• технические записи, необходимые для работы бота, защиты результатов и диагностики ошибок;
• для победителей — Steam ID, ссылка на Steam-профиль и/или Trade URL, если они потребуются для передачи приза.

<b>Цели обработки:</b>
регистрация, идентификация участника, сопоставление с карточкой BERSERK/Gizmo, приём прогнозов, подсчёт результатов, формирование рейтинга, начисление баллов и бонусов, определение победителей, передача призов, предотвращение злоупотреблений и техническая поддержка.

Оператор вправе осуществлять сбор, запись, систематизацию, накопление, хранение, уточнение, использование, сопоставление, блокирование, удаление и уничтожение указанных данных.

Срок обработки: период проведения конкурса и до <b>1 года после его завершения</b>, если иной срок не требуется законом.

Согласие можно отозвать через Telegram:
<b>/privacy → Отозвать согласие</b>.

Распространение имени другим пользователям рейтинга в это согласие <b>не входит</b>. Выбор отображения имени будет запрошен отдельно.

Версия согласия: <code>${TI_PRIVACY_VERSION}</code>`,

    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                '✅ Согласен на обработку ПД',
              callback_data:
                'ti:legal:privacy:accept'
            }
          ],
          [
            {
              text:
                '❌ Не согласен',
              callback_data:
                'ti:legal:privacy:decline'
            }
          ],
          [
            {
              text:
                '← Правила конкурса',
              callback_data:
                'ti:rules:1'
            }
          ]
        ]
      }
    }
  );
}


async function showTiPublicationChoice(
  chatId,
  {
    fromPrivacy = false
  } = {}
) {
  const prefix =
    fromPrivacy
      ? 'ti:privacy:name:set:'
      : 'ti:legal:name:set:';


  await tiSend(
    chatId,

    `👤 <b>ОТОБРАЖЕНИЕ В РЕЙТИНГЕ</b>

Это отдельный выбор от согласия на обработку персональных данных.

Если выбрать <b>«Показывать имя»</b>, вы разрешаете отображать другим пользователям рейтинга:
• username или имя из карточки BERSERK/Gizmo;
• место в рейтинге;
• количество баллов;
• для основной группы — количество бонусных ₽.

Если выбрать <b>«Псевдоним»</b>, имя и username публично не показываются. В рейтинге используется технический псевдоним вида <code>TI_berserk_...</code>.

Отказ от публикации имени <b>не мешает участию в конкурсе</b>.

Выбор можно позже изменить в разделе «🔐 Персональные данные».

Версия: <code>${TI_PUBLICATION_VERSION}</code>`,

    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                '✅ Показывать имя',
              callback_data:
                `${prefix}name`
            }
          ],
          [
            {
              text:
                '👤 Участвовать под псевдонимом',
              callback_data:
                `${prefix}pseudonym`
            }
          ]
        ]
      }
    }
  );
}


async function showTiLegalDeclined(
  chatId,
  kind
) {
  const reason =
    kind === 'privacy'
      ? 'Без обработки данных, необходимых для идентификации участника, хранения прогнозов и подсчёта результатов, регистрация в конкурсе невозможна.'
      : 'Без принятия Правил участие в конкурсе невозможно.';


  await tiSend(
    chatId,

    `ℹ️ <b>РЕГИСТРАЦИЯ НЕ ЗАВЕРШЕНА</b>

${reason}

Если передумаешь — отправь /start и продолжи регистрацию.`,

    {
      reply_markup: {
        remove_keyboard:
          true
      }
    }
  );
}


async function showNextTiRegistrationStep(
  chatId,
  user,
  {
    requirePhone = true
  } = {}
) {
  if (
    hasTiPrivacyWithdrawal(
      user
    )
  ) {
    await showTiPrivacyWithdrawn(
      chatId,
      user
    );

    return false;
  }


  if (
    !hasCurrentTiRules(
      user
    )
  ) {
    await showTiRulesPage(
      chatId,
      user,
      1
    );

    return false;
  }


  if (
    !hasCurrentTiPrivacyConsent(
      user
    )
  ) {
    await showTiPrivacyConsent(
      chatId
    );

    return false;
  }


  if (
    !hasTiRatingNameChoice(
      user
    )
  ) {
    await showTiPublicationChoice(
      chatId
    );

    return false;
  }


  if (
    requirePhone &&
    Number(user.phone_verified) !== 1
  ) {
    await showTiPhoneRequest(
      chatId
    );

    return false;
  }


  return true;
}


async function acceptTiRulesAndContinue(
  chatId,
  telegramId
) {
  const before =
    await getTiUserByTelegramId(
      telegramId
    );


  if (
    hasTiPrivacyWithdrawal(
      before
    )
  ) {
    await showTiPrivacyWithdrawn(
      chatId,
      before
    );

    return;
  }


  await acceptTiRules({
    telegramId,
    version:
      TI_RULES_VERSION
  });


  const user =
    await getTiUserByTelegramId(
      telegramId
    );


  console.log(
    new Date().toISOString(),
    '[TI LEGAL] rules accepted',
    `telegram_id=${telegramId}`,
    `version=${TI_RULES_VERSION}`
  );


  await showNextTiRegistrationStep(
    chatId,
    user
  );
}


async function acceptTiPrivacyAndContinue(
  chatId,
  telegramId
) {
  const before =
    await getTiUserByTelegramId(
      telegramId
    );


  if (
    hasTiPrivacyWithdrawal(
      before
    )
  ) {
    await showTiPrivacyWithdrawn(
      chatId,
      before
    );

    return;
  }


  if (
    !hasCurrentTiRules(
      before
    )
  ) {
    await showTiRulesPage(
      chatId,
      before,
      1
    );

    return;
  }


  await acceptTiPrivacyConsent({
    telegramId,
    version:
      TI_PRIVACY_VERSION
  });


  const user =
    await getTiUserByTelegramId(
      telegramId
    );


  console.log(
    new Date().toISOString(),
    '[TI LEGAL] privacy consent accepted',
    `telegram_id=${telegramId}`,
    `version=${TI_PRIVACY_VERSION}`
  );


  await showNextTiRegistrationStep(
    chatId,
    user
  );
}


async function setTiInitialRatingNameModeAndContinue(
  chatId,
  telegramId,
  mode
) {
  const before =
    await getTiUserByTelegramId(
      telegramId
    );


  if (
    hasTiPrivacyWithdrawal(
      before
    )
  ) {
    await showTiPrivacyWithdrawn(
      chatId,
      before
    );

    return;
  }


  if (
    !hasCurrentTiPrivacyConsent(
      before
    )
  ) {
    await showNextTiRegistrationStep(
      chatId,
      before
    );

    return;
  }


  await setTiRatingNameMode({
    telegramId,
    mode,
    version:
      TI_PUBLICATION_VERSION
  });


  const user =
    await getTiUserByTelegramId(
      telegramId
    );


  console.log(
    new Date().toISOString(),
    '[TI LEGAL] rating name mode',
    `telegram_id=${telegramId}`,
    `mode=${mode}`,
    `version=${TI_PUBLICATION_VERSION}`
  );


  const ready =
    await showNextTiRegistrationStep(
      chatId,
      user
    );


  if (ready) {
    await showMainMenu(
      chatId
    );
  }
}


// ==================================================
// REGISTRATION — USER
// ==================================================

async function showTiPhoneRequest(
  chatId
) {
  await tiSend(
    chatId,

    `📱 <b>ПОДТВЕРЖДЕНИЕ НОМЕРА</b>

Для участия в прогнозах отправь номер телефона, привязанный к твоему Telegram-аккаунту.

Нажми кнопку ниже — вводить номер вручную не нужно.`,

    {
      reply_markup: {
        keyboard: [
          [
            {
              text:
                '📱 Поделиться номером телефона',

              request_contact:
                true
            }
          ]
        ],

        resize_keyboard:
          true,

        one_time_keyboard:
          true
      }
    }
  );
}


async function getTiPredictionUser(
  chatId,
  telegramId
) {
  const user =
    await getTiUserByTelegramId(
      telegramId
    );


  if (!user) {
    await tiSend(
      chatId,
      '⚠️ Сначала отправь /start.'
    );

    return null;
  }


  if (
    hasTiPrivacyWithdrawal(
      user
    )
  ) {
    await showTiPrivacyWithdrawn(
      chatId,
      user
    );

    return null;
  }


  if (
    Number(user.is_active) !== 1
  ) {
    await tiSend(
      chatId,
      '⛔ Участие для этого аккаунта отключено.'
    );

    return null;
  }


  if (
    !hasCurrentTiLegalConsents(
      user
    )
  ) {
    await showNextTiRegistrationStep(
      chatId,
      user
    );

    return null;
  }


  if (
    !canTiUserPredict(user)
  ) {
    await showTiPhoneRequest(
      chatId
    );

    return null;
  }


  return user;
}


async function handleTiContact(
  message
) {
  const chatId =
    message.chat?.id;


  if (!chatId) {
    return;
  }


  const currentUser =
    await registerTiUser(
      message.from
    );


  if (
    hasTiPrivacyWithdrawal(
      currentUser
    )
  ) {
    await showTiPrivacyWithdrawn(
      chatId,
      currentUser
    );

    return;
  }


  const legalReady =
    await showNextTiRegistrationStep(
      chatId,
      currentUser,
      {
        requirePhone: false
      }
    );


  if (!legalReady) {
    return;
  }


  const result =
    await registerTiPhone(
      message
    );


  if (!result.ok) {
    if (
      result.reason ===
      'foreign_contact'
    ) {
      await tiSend(
        chatId,

        `⛔ Нужно отправить <b>свой</b> номер телефона, привязанный к этому Telegram-аккаунту.`,

        {
          reply_markup: {
            remove_keyboard:
              true
          }
        }
      );

      await showTiPhoneRequest(
        chatId
      );

      return;
    }


    await tiSend(
      chatId,

      `❌ Не удалось подтвердить номер телефона. Попробуй ещё раз через кнопку ниже.`,

      {
        reply_markup: {
          remove_keyboard:
            true
        }
      }
    );

    await showTiPhoneRequest(
      chatId
    );

    return;
  }


  if (
    result.alreadyApproved
  ) {
    await tiSend(
      chatId,

      `✅ <b>НОМЕР ПОДТВЕРЖДЁН</b>

Регистрация уже подтверждена администратором.

🎯 Прогнозы доступны. Баллы и бонусные рубли учитываются.`,

      {
        reply_markup: {
          remove_keyboard:
            true
        }
      }
    );


    await showMainMenu(
      chatId
    );


    return;
  }


  let gizmoText;


  if (
    result.gizmoMatchStatus ===
    'exact'
  ) {
    const gizmo =
      result.gizmoUsers?.[0];

    gizmoText =
      `✅ Карточка BERSERK найдена` +
      `${gizmo?.username ? `: <b>${gizmo.username}</b>` : '.'}`;

  } else if (
    result.gizmoMatchStatus ===
    'multiple'
  ) {
    gizmoText =
      '⚠️ Найдено несколько карточек BERSERK с этим номером. Администратор проверит нужную карточку в клубе.';

  } else if (
    result.gizmoMatchStatus ===
    'error'
  ) {
    gizmoText =
      '⚠️ Номер подтверждён. Проверка карточки BERSERK временно недоступна — администратор проверит её в клубе.';

  } else {
    gizmoText =
      'ℹ️ Карточка BERSERK по номеру автоматически не найдена. Администратор проверит регистрацию в клубе.';
  }


  await tiSend(
    chatId,

    `✅ <b>НОМЕР ПОДТВЕРЖДЁН</b>

${gizmoText}

🎯 Прогнозы уже доступны.

⏳ Баллы и бонусные рубли будут учитываться после подтверждения регистрации администратором в клубе.`,

    {
      reply_markup: {
        remove_keyboard:
          true
      }
    }
  );


  await showMainMenu(
    chatId
  );
}


// ==================================================
// PRIVACY
// ==================================================

function hasTiPrivacyWithdrawal(
  user
) {
  return Boolean(
    user?.privacy_withdrawal_requested_at
  );
}


async function showTiPrivacyWithdrawn(
  chatId,
  user
) {
  const requestedAt =
    user?.privacy_withdrawal_requested_at
      ? new Date(
          user.privacy_withdrawal_requested_at
        ).toLocaleString(
          'ru-RU',
          {
            timeZone:
              'Europe/Moscow'
          }
        )
      : '-';


  await tiSend(
    chatId,

    `🔐 <b>ОТЗЫВ СОГЛАСИЯ ЗАРЕГИСТРИРОВАН</b>

Дата запроса: <b>${requestedAt}</b> (МСК)

Участие в конкурсе остановлено:
• новые прогнозы недоступны;
• пользователь не отображается в рейтингах;
• автоматическое обновление карточки BERSERK/Gizmo прекращено.

Оператор персональных данных:
<b>ИП Суровцев Данил Романович</b>
ИНН 773126145324
ОГРНИП 324774600720432
г. Москва, ул. Кастанаевская, д. 41, корп. 2
Компьютерный клуб BERSERK.

Запрос на прекращение обработки и удаление персональных данных обрабатывается Организатором с учётом требований законодательства РФ.`,

    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                '📜 Правила конкурса',

              callback_data:
                'ti:rules:1'
            }
          ],

          [
            {
              text:
                '🔐 Персональные данные',

              callback_data:
                'ti:privacy'
            }
          ]
        ]
      }
    }
  );
}


async function showTiPrivacyMenu(
  chatId,
  user
) {
  if (
    hasTiPrivacyWithdrawal(
      user
    )
  ) {
    await showTiPrivacyWithdrawn(
      chatId,
      user
    );

    return;
  }


  const rulesStatus =
    hasCurrentTiRules(user)
      ? `✅ ${user.rules_version}`
      : '❌ не приняты';

  const privacyStatus =
    hasCurrentTiPrivacyConsent(user)
      ? `✅ ${user.privacy_consent_version}`
      : '❌ согласие не предоставлено';

  const nameMode =
    user?.rating_name_mode === 'name'
      ? '✅ показывать имя'
      : user?.rating_name_mode === 'pseudonym'
        ? '👤 псевдоним'
        : '❌ не выбран';


  const keyboard = [];


  if (
    !hasCurrentTiLegalConsents(
      user
    )
  ) {
    keyboard.push([
      {
        text:
          '➡️ Продолжить регистрацию',
        callback_data:
          'ti:legal:continue'
      }
    ]);

  } else {
    keyboard.push([
      {
        text:
          '👤 Изменить отображение имени',
        callback_data:
          'ti:privacy:name:change'
      }
    ]);

    keyboard.push([
      {
        text:
          '⚠️ Отозвать согласие',
        callback_data:
          'ti:privacy:revoke:ask'
      }
    ]);
  }


  keyboard.push([
    {
      text:
        '📜 Правила конкурса',
      callback_data:
        'ti:rules:1'
    }
  ]);


  if (
    hasCurrentTiLegalConsents(
      user
    ) &&
    Number(user.phone_verified) === 1
  ) {
    keyboard.push([
      {
        text:
          '🏠 Главное меню',
        callback_data:
          'ti:menu'
      }
    ]);
  }


  await tiSend(
    chatId,

    `🔐 <b>ПЕРСОНАЛЬНЫЕ ДАННЫЕ И СОГЛАСИЯ</b>

Оператор:
<b>ИП Суровцев Данил Романович</b>
ИНН 773126145324
ОГРНИП 324774600720432
г. Москва, ул. Кастанаевская, д. 41, корп. 2
Компьютерный клуб BERSERK.

<b>Статус:</b>
📜 Правила: ${rulesStatus}
🔐 ПД: ${privacyStatus}
👤 Рейтинг: ${nameMode}

В рамках конкурса могут храниться:
• Telegram ID, username, имя и фамилия;
• номер телефона и статус его подтверждения;
• ID и данные карточки BERSERK/Gizmo;
• статус регистрации;
• прогнозы и время их изменения;
• результаты, баллы и группа рейтинга;
• сведения о согласиях;
• технические данные, необходимые для работы бота.

Отозвать согласие на обработку персональных данных можно непосредственно через Telegram-бот.`,

    {
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    }
  );
}


async function showTiPrivacyRevokeConfirmation(
  chatId
) {
  await tiSend(
    chatId,

    `⚠️ <b>ПОДТВЕРЖДЕНИЕ ОТЗЫВА</b>

После подтверждения:
• новые прогнозы будут недоступны;
• аккаунт сразу исчезнет из конкурсного рейтинга и рейтинга «Вне конкурса»;
• автоматическая синхронизация с BERSERK/Gizmo для этого участника прекратится;
• Организатор зарегистрирует запрос на прекращение обработки и удаление данных.

<b>Это действие нельзя отменить простой кнопкой.</b>
Для повторного участия потребуется заново оформить необходимые согласия.`,

    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                '✅ Да, отозвать согласие',

              callback_data:
                'ti:privacy:revoke:confirm'
            }
          ],

          [
            {
              text:
                '← Отмена',

              callback_data:
                'ti:privacy'
            }
          ]
        ]
      }
    }
  );
}


async function confirmTiPrivacyWithdrawal(
  chatId,
  telegramId
) {
  await requestTiPrivacyWithdrawal({
    telegramId,
    channel:
      'telegram_bot'
  });


  const user =
    await getTiUserByTelegramId(
      telegramId
    );


  console.log(
    new Date().toISOString(),
    '[TI PRIVACY] withdrawal requested',
    `telegram_id=${telegramId}`
  );


  await showTiPrivacyWithdrawn(
    chatId,
    user
  );
}


// ==================================================
// USER NAVIGATION
// ==================================================

function getTiMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text:
            '🏠 Главное меню',

          callback_data:
            'ti:menu'
        }
      ]
    ]
  };
}


// ==================================================
// MAIN MENU
// ==================================================

async function showMainMenu(
  chatId
) {
  await tiSend(
    chatId,

    `🏆 <b>BERSERK — THE INTERNATIONAL</b>

Прогнозируй победителей матчей
и набирай баллы.

🎁 Призы:
🥇 Arcana до 3 000 ₽
🥈 Arcana до 2 500 ₽
🥉 Arcana до 2 000 ₽`,

    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                '🎯 Сделать прогноз',

              callback_data:
                'ti:predict'
            }
          ],

          [
            {
              text:
                '📅 Матчи',

              callback_data:
                'ti:matches'
            },

            {
              text:
                '📊 Мои прогнозы',

              callback_data:
                'ti:my'
            }
          ],

          [
            {
              text:
                '🏆 Рейтинг',

              callback_data:
                'ti:rating'
            }
          ],

          [
            {
              text:
                '🖼 Сетка',

              callback_data:
                'ti:bracket'
            }
          ],

          [
            {
              text:
                '🔐 Персональные данные',

              callback_data:
                'ti:privacy'
            }
          ]
        ]
      }
    }
  );
}


// ==================================================
// USER — BRACKET
// ==================================================

async function showTiBracket(
  chatId
) {
  await ensureTiBracketCurrent({
    chatId
  });


  await tiSendPhoto(
    chatId,

    BRACKET_OUTPUT,

    '🏆 <b>THE INTERNATIONAL 2026 — PLAYOFF</b>',

    {
      reply_markup:
        getTiMainMenuKeyboard()
    }
  );
}


// ==================================================
// PREDICTION MATCHES
// ==================================================

async function showPredictionMatches(
  chatId,
  telegramId
) {
  const user =
    await getTiPredictionUser(
      chatId,
      telegramId
    );


  if (!user) {
    return;
  }


  const matches =
    await getOpenTiMatches();


  if (
    !matches.length
  ) {
    await tiSend(
      chatId,

      '🎯 <b>Прогнозы</b>\n\n' +
      'Сейчас нет матчей, доступных для ставок.',

      {
        reply_markup:
          getTiMainMenuKeyboard()
      }
    );

    return;
  }


  await tiSend(
    chatId,

    `🎯 <b>СДЕЛАТЬ ПРОГНОЗ</b>

Выбери победителя каждого матча.

Прогноз можно изменить до начала матча.`
  );


  for (
    const match
    of matches
  ) {
    const time =
      formatDateTime(
        match.start_time
      );


    await tiSend(
      chatId,

      `⚔️ <b>${match.team_a_name} — ${match.team_b_name}</b>

🕐 ${time} МСК
🏆 ${match.points} балл за правильный прогноз

Кто победит?`,

      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  `🔥 ${match.team_a_name}`,

                callback_data:
                  `ti:bet:${match.id}:${match.team_a_id}`
              }
            ],

            [
              {
                text:
                  `🔥 ${match.team_b_name}`,

                callback_data:
                  `ti:bet:${match.id}:${match.team_b_id}`
              }
            ]
          ]
        }
      }
    );
  }


  await tiSend(
    chatId,
    '🏠 Вернуться к разделам турнира:',
    {
      reply_markup:
        getTiMainMenuKeyboard()
    }
  );
}


// ==================================================
// SAVE PREDICTION
// ==================================================

async function makePrediction(
  query,
  matchId,
  teamId
) {
  const telegramId =
    query.from.id;


  const chatId =
    query.message?.chat?.id;


  if (!chatId) {
    return;
  }


  const user =
    await getTiUserByTelegramId(
      telegramId
    );


  if (!user) {
    await tiSend(
      chatId,
      '⚠️ Сначала отправь /start.'
    );

    return;
  }


  if (
    Number(user.is_active) !== 1
  ) {
    await tiSend(
      chatId,
      '⛔ Участие для этого аккаунта отключено.'
    );

    return;
  }


  if (
    !hasCurrentTiLegalConsents(
      user
    )
  ) {
    await showNextTiRegistrationStep(
      chatId,
      user
    );

    return;
  }


  if (
    !canTiUserPredict(user)
  ) {
    await showTiPhoneRequest(
      chatId
    );

    return;
  }


  const match =
    await getTiMatch(
      matchId
    );


  if (!match) {
    await tiSend(
      chatId,
      '❌ Матч не найден.'
    );

    return;
  }


  // Даже старая Telegram-кнопка
  // не должна позволить поставить
  // после закрытия betting.

  if (
    match.status !== 'scheduled' ||
    Number(
      match.betting_closed
    ) === 1 ||
    new Date(
      match.start_time
    ).getTime() <= Date.now()
  ) {
    await tiSend(
      chatId,
      '⛔ Ставки на этот матч уже закрыты.'
    );

    return;
  }


  const teamIdNumber =
    Number(teamId);


  // Защита от подмены team_id
  // в callback_data.

  if (
    teamIdNumber !==
      Number(
        match.team_a_id
      ) &&

    teamIdNumber !==
      Number(
        match.team_b_id
      )
  ) {
    await tiSend(
      chatId,
      '❌ Некорректная команда.'
    );

    return;
  }


  await saveTiPrediction({
    userId:
      user.id,

    matchId:
      match.id,

    teamId:
      teamIdNumber
  });


  const teamName =
    teamIdNumber ===
      Number(
        match.team_a_id
      )
      ? match.team_a_name
      : match.team_b_name;


  await tiSend(
    chatId,

    `✅ <b>ПРОГНОЗ СОХРАНЁН</b>

⚔️ ${match.team_a_name} — ${match.team_b_name}

Ваш выбор:
🟢 <b>${teamName}</b>

До начала матча прогноз можно изменить.`,

    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                '🎯 К прогнозам',

              callback_data:
                'ti:predict'
            }
          ],
          [
            {
              text:
                '🏠 Главное меню',

              callback_data:
                'ti:menu'
            }
          ]
        ]
      }
    }
  );
}


// ==================================================
// UPCOMING MATCHES
// ==================================================

async function showMatches(
  chatId
) {
  const matches =
    await getOpenTiMatches();


  if (
    !matches.length
  ) {
    await tiSend(
      chatId,
      '📅 Сейчас нет предстоящих матчей.',
      {
        reply_markup:
          getTiMainMenuKeyboard()
      }
    );

    return;
  }


  let text =
    '📅 <b>ПРЕДСТОЯЩИЕ МАТЧИ</b>\n\n';


  for (
    const match
    of matches
  ) {
    text +=
      `⚔️ <b>${match.team_a_name}</b> — ` +
      `<b>${match.team_b_name}</b>\n` +

      `🕐 ${formatDateTime(
        match.start_time
      )} МСК\n\n`;
  }


  await tiSend(
    chatId,
    text,
    {
      reply_markup:
        getTiMainMenuKeyboard()
    }
  );
}


// ==================================================
// MY PREDICTIONS
// ==================================================

async function showMyPredictions(
  chatId,
  telegramId
) {
  const user =
    await getTiUserByTelegramId(
      telegramId
    );


  if (!user) {
    await tiSend(
      chatId,
      '⚠️ Сначала отправь /start.'
    );

    return;
  }


  const predictions =
    await getUserPredictions(
      user.id
    );


  if (
    !predictions.length
  ) {
    await tiSend(
      chatId,
      '📊 У тебя пока нет прогнозов.',
      {
        reply_markup:
          getTiMainMenuKeyboard()
      }
    );

    return;
  }


  let text =
    '📊 <b>МОИ ПРОГНОЗЫ</b>\n\n';


  for (
    const prediction
    of predictions
  ) {
    const selected =
      Number(
        prediction.predicted_team_id
      ) ===
      Number(
        prediction.team_a_id
      )
        ? prediction.team_a_name
        : prediction.team_b_name;


    text +=
      `⚔️ ${prediction.team_a_name} — ` +
      `${prediction.team_b_name}\n` +

      `👉 <b>${selected}</b>\n`;


    if (
      prediction.status ===
      'finished'
    ) {
      if (
        Number(
          prediction.predicted_team_id
        ) ===
        Number(
          prediction.winner_team_id
        )
      ) {
        if (
          user.registration_status ===
            'approved' &&
          Number(user.phone_verified) === 1 &&
          String(
            user.rating_group ||
            'main'
          ) === 'out_of_competition'
        ) {
          text +=
            `✅ +${Number(prediction.earned_points || 0)} балл.\n` +
            '🛡 Вне конкурса\n';

        } else if (
          user.registration_status ===
            'approved' &&
          Number(user.phone_verified) === 1
        ) {
          text +=
            `✅ +${Number(prediction.earned_points || 0)} балл.  ` +
            `💰 +${Number(prediction.earned_bonus_rub || 0)} ₽\n`;

        } else {
          text +=
            '✅ Прогноз верный\n' +
            '⏳ Баллы и бонусы будут учтены после подтверждения регистрации\n';
        }

      } else {
        if (
          String(
            user.rating_group ||
            'main'
          ) === 'out_of_competition'
        ) {
          text +=
            '❌ 0 баллов\n' +
            '🛡 Вне конкурса\n';

        } else {
          text +=
            '❌ 0 баллов · 0 ₽\n';
        }
      }

    } else {
      text +=
        '⏳ Матч не завершён\n';
    }


    text += '\n';
  }


  await tiSend(
    chatId,
    text,
    {
      reply_markup:
        getTiMainMenuKeyboard()
    }
  );
}


// ==================================================
// RATING
// ==================================================

// --------------------------------------------------
// Рейтинг
// --------------------------------------------------

function tiRatingEscapeHtml(
  value
) {
  return String(
    value ?? ''
  )
    .replaceAll(
      '&',
      '&amp;'
    )
    .replaceAll(
      '<',
      '&lt;'
    )
    .replaceAll(
      '>',
      '&gt;'
    );
}


function getTiRatingName(
  player
) {
  if (
    player.registration_status !==
      'approved'
  ) {
    return null;
  }


  if (
    String(
      player.rating_name_mode ||
      'pseudonym'
    ) !== 'name'
  ) {
    const temporaryId =
      player.gizmo_user_id ||
      player.id;


    return (
      `TI_berserk_${temporaryId}`
    );
  }


  if (
    player.gizmo_match_status ===
      'exact'
  ) {
    const gizmoUsername =
      String(
        player.gizmo_username ||
        ''
      ).trim();


    if (gizmoUsername) {
      return gizmoUsername;
    }


    const gizmoFullName =
      [
        player.gizmo_first_name,
        player.gizmo_last_name
      ]
        .filter(Boolean)
        .join(' ')
        .trim();


    if (gizmoFullName) {
      return gizmoFullName;
    }
  }


  // Если Gizmo-карточка существует, временное
  // имя строим именно от постоянного Gizmo ID.
  // Если карточка ещё вообще не найдена,
  // технически gizmo_id отсутствует — тогда до
  // будущей привязки используем внутренний TI ID.
  const temporaryId =
    player.gizmo_user_id ||
    player.id;


  return (
    `TI_berserk_${temporaryId}`
  );
}


function getTiRatingMedal(
  position
) {
  if (position === 1) {
    return '🥇';
  }


  if (position === 2) {
    return '🥈';
  }


  if (position === 3) {
    return '🥉';
  }


  return `${position}.`;
}


function appendTiRatingSection({
  text,
  rating,
  telegramId,
  showBonus
}) {
  let myPosition =
    null;


  rating.forEach(
    (player, index) => {
      const position =
        index + 1;


      const medal =
        getTiRatingMedal(
          position
        );


      const approved =
        player.registration_status ===
          'approved';


      const name =
        getTiRatingName(
          player
        );


      const score =
        Number(
          player.score || 0
        );


      const bonusRub =
        Number(
          player.bonus_rub || 0
        );


      if (approved) {
        text +=
          `${medal} <b>${tiRatingEscapeHtml(name)}</b>\n` +
          `🏆 <b>${score}</b> балл.`;


        if (showBonus) {
          text +=
            `  💰 <b>${bonusRub} ₽</b>`;
        }


        text +=
          '\n\n';

      } else {
        text +=
          `${medal}\n` +
          `🏆 <b>${score}</b> балл.\n\n`;
      }


      if (
        Number(
          player.telegram_id
        ) ===
        Number(
          telegramId
        )
      ) {
        myPosition = {
          position,
          score,
          bonusRub,
          approved
        };
      }
    }
  );


  return {
    text,
    myPosition
  };
}


async function showRating(
  chatId,
  telegramId
) {
  const currentUser =
    await getTiUserByTelegramId(
      telegramId
    );


  const isOutOfCompetition =
    currentUser &&
    String(
      currentUser.rating_group ||
      'main'
    ) === 'out_of_competition';


  const mainRating =
    await getTiRating();


  let text =
    '🏆 <b>BERSERK TI — КОНКУРСНЫЙ РЕЙТИНГ</b>\n\n';


  let mainPosition =
    null;


  if (!mainRating.length) {
    text +=
      'Пока нет участников.\n';

  } else {
    const section =
      appendTiRatingSection({
        text,
        rating:
          mainRating,
        telegramId,
        showBonus:
          true
      });


    text =
      section.text;

    mainPosition =
      section.myPosition;
  }


  if (!isOutOfCompetition) {
    if (mainPosition) {
      text +=
        `────────────\n` +
        `Ваше место: <b>#${mainPosition.position}</b>\n` +
        `🏆 Баллы: <b>${mainPosition.score}</b>`;


      if (
        mainPosition.approved
      ) {
        text +=
          `\n💰 Бонусные рубли: <b>${mainPosition.bonusRub} ₽</b>`;
      }
    }


    await tiSend(
      chatId,
      text,
      {
        reply_markup:
          getTiMainMenuKeyboard()
      }
    );

    return;
  }


  const outRating =
    await getTiOutOfCompetitionRating();


  text +=
    '\n\n━━━━━━━━━━━━━━\n' +
    '🛡 <b>РЕЙТИНГ — ВНЕ КОНКУРСА</b>\n\n';


  if (!outRating.length) {
    text +=
      'Пока нет участников вне конкурса.';

  } else {
    const section =
      appendTiRatingSection({
        text,
        rating:
          outRating,
        telegramId,
        showBonus:
          false
      });


    text =
      section.text;


    if (
      section.myPosition
    ) {
      text +=
        `────────────\n` +
        `Ваше место вне конкурса: <b>#${section.myPosition.position}</b>\n` +
        `🏆 Баллы: <b>${section.myPosition.score}</b>`;
    }
  }


  await tiSend(
    chatId,
    text,
    {
      reply_markup:
        getTiMainMenuKeyboard()
    }
  );
}


// ==================================================
// ADMIN — AUTH
// ==================================================

function getTiAdminTelegramIds() {
  return new Set(
    String(
      process.env
        .TI_ADMIN_TELEGRAM_IDS ||
      ''
    )
      .split(',')
      .map(
        value =>
          value.trim()
      )
      .filter(
        Boolean
      )
  );
}


function adminIdsConfigured() {
  return (
    getTiAdminTelegramIds()
      .size > 0
  );
}


function isTiTelegramAdmin(
  telegramId
) {
  return getTiAdminTelegramIds()
    .has(
      String(
        telegramId
      )
    );
}


async function requireTelegramAdmin(
  chatId,
  telegramId
) {
  const allowed =
    isTiTelegramAdmin(
      telegramId
    );


  if (!allowed) {
    console.log(
      new Date().toISOString(),

      '[TI ADMIN] access denied',

      `telegram_id=${telegramId}`,

      `chat_id=${chatId}`
    );


    // Пользователю вообще ничего
    // не сообщаем.
    //
    // Не раскрываем:
    // - наличие admin mode
    // - Telegram ID
    // - название env-переменной
    // - способ настройки админа

    return false;
  }


  return true;
}


// ==================================================
// ADMIN — MODE CHECK
// ==================================================

async function requireAdminMode(
  chatId
) {
  const enabled =
    await isTiAdminMode();


  if (!enabled) {
    await tiSend(
      chatId,

      `⛔ <b>Admin Mode выключен.</b>

Сначала включи его в админском меню.`
    );


    return false;
  }


  return true;
}


// ==================================================
// ADMIN — HELPERS
// ==================================================

function adminTeamName(
  value
) {
  const text =
    String(
      value || ''
    ).trim();


  return (
    text || '?'
  );
}


function adminScoreText(
  match
) {
  if (
    match.score_a === null ||
    match.score_a === undefined ||
    match.score_b === null ||
    match.score_b === undefined
  ) {
    return '-:-';
  }


  return (
    `${match.score_a}:${match.score_b}`
  );
}


function adminStatusText(
  match
) {
  if (
    match.status ===
    'finished'
  ) {
    return '✅';
  }


  if (
    match.status ===
    'live'
  ) {
    return '🔴';
  }


  return '⏳';
}


// ==================================================
// ADMIN — REGISTRATIONS
// ==================================================

function tiAdminDisplayName(
  user
) {
  if (user.username) {
    return `@${user.username}`;
  }


  const fullName =
    [
      user.first_name,
      user.last_name
    ]
      .filter(Boolean)
      .join(' ')
      .trim();


  return (
    fullName ||
    `TI user #${user.id}`
  );
}


function tiAdminFormatPhone(
  value
) {
  const digits =
    String(value || '')
      .replace(/\D/g, '');


  if (
    digits.length === 11 &&
    digits.startsWith('7')
  ) {
    return (
      `+7 ${digits.slice(1, 4)} ` +
      `${digits.slice(4, 7)}-` +
      `${digits.slice(7, 9)}-` +
      `${digits.slice(9, 11)}`
    );
  }


  return (
    value ||
    '-'
  );
}


function tiRatingGroupLabel(
  value
) {
  if (
    String(value || 'main') ===
      'out_of_competition'
  ) {
    return '🛡 Вне конкурса';
  }


  return '🏆 Основная';
}


function tiRatingGroupShortLabel(
  value
) {
  if (
    String(value || 'main') ===
      'out_of_competition'
  ) {
    return '🛡 вне конкурса';
  }


  return '🏆 основная';
}


async function showTiAdminRatingGroups(
  chatId
) {
  const users =
    await getTiUsersForRatingGroups();


  if (!users.length) {
    await tiSend(
      chatId,
      `🛡 <b>ГРУППЫ РЕЙТИНГА</b>

Пользователей с подтверждённым телефоном пока нет.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  '← Админ-меню',

                callback_data:
                  'tiadm:menu'
              }
            ]
          ]
        }
      }
    );

    return;
  }


  const keyboard =
    users.map(
      user => {
        const display =
          user.gizmo_username ||
          [
            user.gizmo_first_name,
            user.gizmo_last_name
          ]
            .filter(Boolean)
            .join(' ')
            .trim() ||
          `TI_berserk_${
            user.gizmo_user_id ||
            user.id
          }`;


        return [
          {
            text:
              `${tiRatingGroupShortLabel(
                user.rating_group
              )} · ${display}`,

            callback_data:
              `tiadm:rgroup:${user.id}`
          }
        ];
      }
    );


  keyboard.push([
    {
      text:
        '← Админ-меню',

      callback_data:
        'tiadm:menu'
    }
  ]);


  await tiSend(
    chatId,

    `🛡 <b>ГРУППЫ РЕЙТИНГА</b>

🏆 <b>Основная</b>
Участвует в конкурсе, получает баллы и бонусные ₽.

🛡 <b>Вне конкурса</b>
Делает прогнозы и имеет отдельный рейтинг, но не влияет на конкурсные места и не получает бонусные ₽.

Выбери пользователя:`,

    {
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    }
  );
}


async function showTiAdminRatingGroupUser(
  chatId,
  userId
) {
  const users =
    await getTiUsersForRatingGroups();


  const user =
    users.find(
      item =>
        Number(item.id) ===
        Number(userId)
    );


  if (!user) {
    await tiSend(
      chatId,
      '❌ Пользователь не найден.'
    );

    return;
  }


  const display =
    user.gizmo_username ||
    [
      user.gizmo_first_name,
      user.gizmo_last_name
    ]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    `TI_berserk_${
      user.gizmo_user_id ||
      user.id
    }`;


  await tiSend(
    chatId,

    `🛡 <b>ГРУППА РЕЙТИНГА</b>

Игрок: <b>${tiRatingEscapeHtml(display)}</b>
TI ID: <code>${user.id}</code>
Gizmo ID: <code>${user.gizmo_user_id || '-'}</code>

Сейчас:
<b>${tiRatingGroupLabel(user.rating_group)}</b>`,

    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                user.rating_group === 'main'
                  ? '✅ 🏆 Основная'
                  : '🏆 Основная',

              callback_data:
                `tiadm:rgroup:set:${user.id}:main`
            }
          ],

          [
            {
              text:
                user.rating_group ===
                  'out_of_competition'
                  ? '✅ 🛡 Вне конкурса'
                  : '🛡 Вне конкурса',

              callback_data:
                `tiadm:rgroup:set:${user.id}:out_of_competition`
            }
          ],

          [
            {
              text:
                '← Все пользователи',

              callback_data:
                'tiadm:rgroups'
            },

            {
              text:
                '⚙️ Меню',

              callback_data:
                'tiadm:menu'
            }
          ]
        ]
      }
    }
  );
}


async function setTiAdminRatingGroup(
  chatId,
  userId,
  ratingGroup
) {
  await setTiUserRatingGroup({
    userId,
    ratingGroup
  });


  await showTiAdminRatingGroupUser(
    chatId,
    userId
  );
}


async function showTiAdminRegistrations(
  chatId
) {
  // При каждом открытии списка получаем
  // свежие данные Gizmo. Если номер только что
  // исправили в Gizmo, карточка найдётся сразу.
  try {
    await refreshTiRegistrations({
      force: true
    });

  } catch (err) {
    console.error(
      new Date().toISOString(),
      '[TI REG] admin list refresh error:',
      err
    );
  }


  const users =
    await getPendingTiRegistrations();


  if (!users.length) {
    await tiSend(
      chatId,

      `👥 <b>TI — РЕГИСТРАЦИИ</b>

✅ Нет заявок, ожидающих проверки.`,

      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  '← Админ-меню',

                callback_data:
                  'tiadm:menu'
              }
            ]
          ]
        }
      }
    );

    return;
  }


  let text =
    `👥 <b>TI — РЕГИСТРАЦИИ</b>\n\n` +
    `Ожидают проверки: <b>${users.length}</b>\n\n` +
    `Открой карточку после проверки пользователя в клубе.`;


  const keyboard =
    users.map(
      user => [
        {
          text:
            `${tiAdminDisplayName(user)} · ${
              user.gizmo_match_status === 'exact'
                ? '✅ Gizmo'
                : user.gizmo_match_status === 'multiple'
                  ? '⚠️ несколько'
                  : user.gizmo_match_status === 'error'
                    ? '⚠️ API'
                    : '⚪ не найден'
            }`,

          callback_data:
            `tiadm:reg:${user.id}`
        }
      ]
    );


  keyboard.push([
    {
      text:
        '← Админ-меню',

      callback_data:
        'tiadm:menu'
    }
  ]);


  await tiSend(
    chatId,
    text,

    {
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    }
  );
}


async function showTiAdminRegistration(
  chatId,
  userId
) {
  // Карточка администратора всегда пытается
  // обновиться из Gizmo непосредственно перед
  // показом. Для уже связанного пользователя
  // обновление идёт по gizmo_user_id.
  try {
    await refreshTiRegistration(
      userId,
      {
        force: true
      }
    );

  } catch (err) {
    console.error(
      new Date().toISOString(),
      '[TI REG] admin card refresh error:',
      err
    );
  }


  const user =
    await getTiRegistration(
      userId
    );


  if (!user) {
    await tiSend(
      chatId,
      '❌ Регистрационная карточка не найдена.'
    );

    return;
  }


  let gizmoText;


  if (
    user.gizmo_match_status ===
    'exact'
  ) {
    gizmoText =
      `✅ <b>Совпадение найдено</b>\n` +
      `Gizmo ID: <code>${user.gizmo_user_id || '-'}</code>\n` +
      `Логин: <b>${user.gizmo_username || '-'}</b>\n` +
      `Имя: ${[
        user.gizmo_first_name,
        user.gizmo_last_name
      ].filter(Boolean).join(' ') || '-'}`;

  } else if (
    user.gizmo_match_status ===
    'multiple'
  ) {
    let matches = [];

    try {
      matches =
        await findTiGizmoUsersByPhone(
          user.phone_normalized
        );
    } catch (err) {
      console.error(
        new Date().toISOString(),
        '[TI REG] Gizmo multiple lookup error:',
        err
      );
    }


    gizmoText =
      `⚠️ <b>Несколько карточек с этим номером</b>`;


    for (
      const match
      of matches.slice(0, 5)
    ) {
      gizmoText +=
        `\n• ID <code>${match.id}</code> · ` +
        `<b>${match.username || '-'}</b> · ` +
        `${[
          match.firstName,
          match.lastName
        ].filter(Boolean).join(' ') || '-'}`;
    }

  } else if (
    user.gizmo_match_status ===
    'error'
  ) {
    gizmoText =
      '⚠️ Ошибка проверки Gizmo API. Проверь карточку пользователя вручную в клубе.';

  } else {
    gizmoText =
      '⚪ По номеру карточка Gizmo автоматически не найдена.';
  }


  const statusText =
    user.registration_status === 'approved'
      ? '✅ Допущен'
      : user.registration_status === 'rejected'
        ? '❌ Отклонён'
        : '⏳ Ожидает проверки';


  const text =
    `👤 <b>РЕГИСТРАЦИОННАЯ КАРТОЧКА TI</b>\n\n` +
    `Telegram: <b>${tiAdminDisplayName(user)}</b>\n` +
    `Telegram ID: <code>${user.telegram_id}</code>\n` +
    `Телефон: <code>${tiAdminFormatPhone(user.phone_normalized || user.phone)}</code>\n` +
    `Телефон Telegram: ${Number(user.phone_verified) === 1 ? '✅ подтверждён' : '❌ нет'}\n\n` +
    `<b>Согласия</b>\n` +
    `Правила: ${hasCurrentTiRules(user) ? '✅' : '❌'} ${user.rules_version || '-'}\n` +
    `ПД: ${hasCurrentTiPrivacyConsent(user) ? '✅' : '❌'} ${user.privacy_consent_version || '-'}\n` +
    `Рейтинг: ${user.rating_name_mode === 'name' ? '✅ имя' : user.rating_name_mode === 'pseudonym' ? '👤 псевдоним' : '❌ не выбрано'}\n\n` +
    `<b>Gizmo</b>\n${gizmoText}\n\n` +
    `Статус: <b>${statusText}</b>\n` +
    `Группа: <b>${tiRatingGroupLabel(user.rating_group)}</b>`;


  const keyboard = [];


  if (
    Number(user.phone_verified) === 1 &&
    user.registration_status ===
      'pending_admin'
  ) {
    keyboard.push([
      {
        text:
          '✅ Допустить',

        callback_data:
          `tiadm:reg:approve:${user.id}`
      },

      {
        text:
          '❌ Отклонить',

        callback_data:
          `tiadm:reg:reject:${user.id}`
      }
    ]);
  }


  keyboard.push([
    {
      text:
        '← Регистрации',

      callback_data:
        'tiadm:registrations'
    },

    {
      text:
        '⚙️ Меню',

      callback_data:
        'tiadm:menu'
    }
  ]);


  await tiSend(
    chatId,
    text,

    {
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    }
  );
}


async function notifyTiRegistrationUser(
  telegramId,
  text
) {
  try {
    await tiSend(
      telegramId,
      text
    );

  } catch (err) {
    console.error(
      new Date().toISOString(),
      '[TI REG] user notification error:',
      err
    );
  }
}


async function approveTiRegistrationFromAdmin(
  chatId,
  userId,
  adminTelegramId
) {
  // Последняя синхронизация прямо перед approve.
  // Даже старая открытая Telegram-кнопка получает
  // актуальную карточку Gizmo перед решением.
  try {
    await refreshTiRegistration(
      userId,
      {
        force: true
      }
    );

  } catch (err) {
    console.error(
      new Date().toISOString(),
      '[TI REG] pre-approve refresh error:',
      err
    );
  }


  const user =
    await getTiRegistration(
      userId
    );


  if (!user) {
    await tiSend(
      chatId,
      '❌ Регистрационная карточка не найдена.'
    );

    return;
  }


  if (
    !hasCurrentTiLegalConsents(
      user
    )
  ) {
    await tiSend(
      chatId,
      '⛔ Нельзя допустить участника: обязательные правила/согласия ещё не оформлены.'
    );

    return;
  }


  if (
    Number(user.phone_verified) !== 1
  ) {
    await tiSend(
      chatId,
      '⛔ Нельзя допустить пользователя без подтверждённого Telegram-телефона.'
    );

    return;
  }


  await approveTiRegistration({
    userId,
    adminTelegramId
  });


  await notifyTiRegistrationUser(
    user.telegram_id,

    `✅ <b>Регистрация подтверждена.</b>

Баллы и бонусные рубли за правильные прогнозы теперь учитываются в рейтинге BERSERK TI.`
  );


  await showTiAdminRegistration(
    chatId,
    userId
  );
}


async function rejectTiRegistrationFromAdmin(
  chatId,
  userId,
  adminTelegramId
) {
  const user =
    await getTiRegistration(
      userId
    );


  if (!user) {
    await tiSend(
      chatId,
      '❌ Регистрационная карточка не найдена.'
    );

    return;
  }


  await rejectTiRegistration({
    userId,
    adminTelegramId
  });


  await notifyTiRegistrationUser(
    user.telegram_id,

    `❌ <b>Регистрация не подтверждена.</b>

Прогнозы можно продолжать делать, но баллы и бонусные рубли не учитываются до подтверждения регистрации администратором.`
  );


  await showTiAdminRegistration(
    chatId,
    userId
  );
}


// ==================================================
// ADMIN — MAIN MENU
// ==================================================

async function showTiAdminMenu(
  chatId
) {
  const enabled =
    await isTiAdminMode();


  await tiSend(
    chatId,

    `⚙️ <b>TI ADMIN</b>

Admin Mode: ${
      enabled
        ? '🟢 ON'
        : '⚪ OFF'
    }`,

    {
      reply_markup: {
        inline_keyboard: [

          [
            {
              text:
                '📋 Матчи',

              callback_data:
                'tiadm:matches'
            }
          ],

          [
            {
              text:
                '👥 Регистрации',

              callback_data:
                'tiadm:registrations'
            }
          ],

          [
            {
              text:
                '🛡 Группы рейтинга',

              callback_data:
                'tiadm:rgroups'
            }
          ],

          [
            {
              text:
                '🖼 Показать сетку',

              callback_data:
                'tiadm:bracket'
            }
          ],

          [
            {
              text:
                enabled
                  ? '🔴 Выключить Admin Mode'
                  : '🟢 Включить Admin Mode',

              callback_data:
                enabled
                  ? 'tiadm:mode:off'
                  : 'tiadm:mode:on'
            }
          ],

          [
            {
              text:
                '🧹 Reset all playoff',

              callback_data:
                'tiadm:resetallask'
            }
          ]
        ]
      }
    }
  );
}


// ==================================================
// ADMIN — MATCH LIST
// ==================================================

async function showTiAdminMatches(
  chatId
) {
  const matches =
    await getTiAdminMatches();


  let text =
    '📋 <b>TI ADMIN — МАТЧИ</b>\n\n';


  const keyboard = [];


  for (
    const match
    of matches
  ) {
    const nodeId =
      Number(
        match.source_match_id
      );


    const teamA =
      adminTeamName(
        match.team_a_name
      );


    const teamB =
      adminTeamName(
        match.team_b_name
      );


    const score =
      adminScoreText(
        match
      );


    text +=
      `${adminStatusText(match)} ` +

      `<b>#${nodeId}</b> ` +

      `${teamA} ` +
      `${score} ` +
      `${teamB}\n`;


    keyboard.push([
      {
        text:
          `#${nodeId} ` +
          `${teamA} — ${teamB}`,

        callback_data:
          `tiadm:match:${nodeId}`
      }
    ]);
  }


  keyboard.push([
    {
      text:
        '← Админ-меню',

      callback_data:
        'tiadm:menu'
    }
  ]);


  await tiSend(
    chatId,
    text,

    {
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    }
  );
}


// ==================================================
// ADMIN — SCORE BUTTONS
// ==================================================

function getAdminResultButtons(
  nodeId
) {
  // Grand Final node 21 = BO5.
  // Остальные playoff = BO3.

  const scores =
    Number(nodeId) === 21
      ? [
          [3, 0],
          [3, 1],
          [3, 2],

          [0, 3],
          [1, 3],
          [2, 3]
        ]

      : [
          [2, 0],
          [2, 1],

          [0, 2],
          [1, 2]
        ];


  const rows = [];


  for (
    let i = 0;
    i < scores.length;
    i += 2
  ) {
    rows.push(
      scores
        .slice(
          i,
          i + 2
        )
        .map(
          ([a, b]) => ({
            text:
              `${a}:${b}`,

            callback_data:
              `tiadm:pick:${nodeId}:${a}:${b}`
          })
        )
    );
  }


  return rows;
}


// ==================================================
// ADMIN — ONE MATCH
// ==================================================

async function showTiAdminMatch(
  chatId,
  nodeId
) {
  const match =
    await getTiAdminMatch(
      nodeId
    );


  if (!match) {
    await tiSend(
      chatId,
      `❌ Node ${nodeId} не найден.`
    );


    return;
  }


  const teamA =
    adminTeamName(
      match.team_a_name
    );


  const teamB =
    adminTeamName(
      match.team_b_name
    );


  const bothTeamsKnown =
    Boolean(
      match.team_a_id &&
      match.team_b_id
    );


  let text =
    `⚙️ <b>NODE ${nodeId}</b>\n\n` +

    `⚔️ <b>${teamA}</b> — ` +
    `<b>${teamB}</b>\n` +

    `Счёт: ` +
    `<b>${adminScoreText(match)}</b>\n` +

    `Статус: ` +
    `<b>${match.status}</b>\n` +

    `Winner: ` +
    `<code>${match.winner_team_id || '-'}</code>`;


  if (
    !bothTeamsKnown
  ) {
    text +=
      '\n\n⚠️ Обе команды ещё не определены.';
  }


  const keyboard = [];


  if (
    bothTeamsKnown
  ) {
    keyboard.push(
      ...getAdminResultButtons(
        nodeId
      )
    );
  }


  keyboard.push([
    {
      text:
        '↩️ Сбросить результат',

      callback_data:
        `tiadm:resetask:${nodeId}`
    }
  ]);


  keyboard.push([
    {
      text:
        '← Матчи',

      callback_data:
        'tiadm:matches'
    },

    {
      text:
        '⚙️ Меню',

      callback_data:
        'tiadm:menu'
    }
  ]);


  await tiSend(
    chatId,
    text,

    {
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    }
  );
}


// ==================================================
// ADMIN — RESULT CONFIRMATION
// ==================================================

async function showTiAdminResultConfirmation(
  chatId,
  nodeId,
  scoreA,
  scoreB
) {
  const match =
    await getTiAdminMatch(
      nodeId
    );


  if (!match) {
    await tiSend(
      chatId,
      `❌ Node ${nodeId} не найден.`
    );


    return;
  }


  if (
    !match.team_a_id ||
    !match.team_b_id
  ) {
    await tiSend(
      chatId,
      '❌ Обе команды ещё не определены.'
    );


    return;
  }


  const winner =
    Number(scoreA) >
    Number(scoreB)
      ? match.team_a_name
      : match.team_b_name;


  await tiSend(
    chatId,

    `⚠️ <b>Подтвердить результат?</b>

Node <b>${nodeId}</b>

${adminTeamName(match.team_a_name)} <b>${scoreA}:${scoreB}</b> ${adminTeamName(match.team_b_name)}

Победитель:
🏆 <b>${adminTeamName(winner)}</b>

Зависимая ветка сетки будет пересчитана автоматически.`,

    {
      reply_markup: {
        inline_keyboard: [

          [
            {
              text:
                '✅ Подтвердить',

              callback_data:
                `tiadm:set:${nodeId}:${scoreA}:${scoreB}`
            }
          ],

          [
            {
              text:
                '← Отмена',

              callback_data:
                `tiadm:match:${nodeId}`
            }
          ]
        ]
      }
    }
  );
}


// ==================================================
// ADMIN — APPLY RESULT
// ==================================================

async function applyTiAdminResult(
  chatId,
  nodeId,
  scoreA,
  scoreB
) {
  if (
    !await requireAdminMode(
      chatId
    )
  ) {
    return;
  }


  const result =
    await setTiAdminResult({
      nodeId,
      scoreA,
      scoreB
    });


  const affected =
    result.affectedNodes?.length
      ? result.affectedNodes
          .join(', ')
      : '-';


  await tiSend(
    chatId,

    `${result.unchanged ? 'ℹ️' : '✅'} ` +

    `<b>${
      result.unchanged
        ? 'РЕЗУЛЬТАТ БЕЗ ИЗМЕНЕНИЙ'
        : 'РЕЗУЛЬТАТ СОХРАНЁН'
    }</b>

Node <b>${result.nodeId}</b>

${result.teamAName} <b>${result.scoreA}:${result.scoreB}</b> ${result.teamBName}

🏆 ${result.winnerTeamName}

Затронутые nodes:
<code>${affected}</code>`,

    {
      reply_markup: {
        inline_keyboard: [

          [
            {
              text:
                'Открыть матч',

              callback_data:
                `tiadm:match:${result.nodeId}`
            },

            {
              text:
                '📋 Матчи',

              callback_data:
                'tiadm:matches'
            }
          ],

          [
            {
              text:
                '🖼 Сетка',

              callback_data:
                'tiadm:bracket'
            }
          ]
        ]
      }
    }
  );
}


// ==================================================
// ADMIN — RESET CONFIRMATION
// ==================================================

async function showTiAdminResetConfirmation(
  chatId,
  nodeId
) {
  const match =
    await getTiAdminMatch(
      nodeId
    );


  if (!match) {
    await tiSend(
      chatId,
      `❌ Node ${nodeId} не найден.`
    );


    return;
  }


  await tiSend(
    chatId,

    `⚠️ <b>Сбросить результат?</b>

Node <b>${nodeId}</b>

${adminTeamName(match.team_a_name)} — ${adminTeamName(match.team_b_name)}

Зависимая ветка будет очищена каскадом.`,

    {
      reply_markup: {
        inline_keyboard: [

          [
            {
              text:
                '✅ Сбросить',

              callback_data:
                `tiadm:reset:${nodeId}`
            }
          ],

          [
            {
              text:
                '← Отмена',

              callback_data:
                `tiadm:match:${nodeId}`
            }
          ]
        ]
      }
    }
  );
}


// ==================================================
// ADMIN — RESET ONE
// ==================================================

async function applyTiAdminReset(
  chatId,
  nodeId
) {
  if (
    !await requireAdminMode(
      chatId
    )
  ) {
    return;
  }


  const result =
    await resetTiAdminResult(
      nodeId
    );


  const affected =
    result.affectedNodes?.length
      ? result.affectedNodes
          .join(', ')
      : '-';


  await tiSend(
    chatId,

    `✅ <b>RESULT RESET + CASCADE</b>

Node <b>${result.nodeId}</b>

${adminTeamName(result.teamAName)} — ${adminTeamName(result.teamBName)}

Затронутые nodes:
<code>${affected}</code>`,

    {
      reply_markup: {
        inline_keyboard: [

          [
            {
              text:
                '📋 Матчи',

              callback_data:
                'tiadm:matches'
            },

            {
              text:
                '🖼 Сетка',

              callback_data:
                'tiadm:bracket'
            }
          ]
        ]
      }
    }
  );
}


// ==================================================
// ADMIN — RESET ALL CONFIRM
// ==================================================

async function showTiAdminResetAllConfirmation(
  chatId
) {
  await tiSend(
    chatId,

    `⚠️ <b>RESET ALL PLAYOFF?</b>

Будут сброшены результаты и зависимые команды по всей playoff-сетке.

Исходные пары nodes 14–17 сохранятся.`,

    {
      reply_markup: {
        inline_keyboard: [

          [
            {
              text:
                '🧹 Да, reset all',

              callback_data:
                'tiadm:resetall'
            }
          ],

          [
            {
              text:
                '← Отмена',

              callback_data:
                'tiadm:menu'
            }
          ]
        ]
      }
    }
  );
}


// ==================================================
// ADMIN — RESET ALL
// ==================================================

async function applyTiAdminResetAll(
  chatId
) {
  if (
    !await requireAdminMode(
      chatId
    )
  ) {
    return;
  }


  const result =
    await resetTiAdminPlayoff();


  await tiSend(
    chatId,

    `✅ <b>PLAYOFF RESET COMPLETE</b>

Source nodes:
<code>${result.sourceNodes.join(', ')}</code>

Affected:
<code>${result.affectedNodes.join(', ')}</code>`,

    {
      reply_markup: {
        inline_keyboard: [

          [
            {
              text:
                '📋 Матчи',

              callback_data:
                'tiadm:matches'
            }
          ],

          [
            {
              text:
                '🖼 Сетка',

              callback_data:
                'tiadm:bracket'
            }
          ]
        ]
      }
    }
  );
}


// ==================================================
// ADMIN — GENERATE BRACKET
// ==================================================

async function showTiAdminBracket(
  chatId
) {
  await ensureTiBracketCurrent({
    chatId
  });


  await tiSendPhoto(
    chatId,

    BRACKET_OUTPUT,

    '🏆 <b>THE INTERNATIONAL 2026 — PLAYOFF</b>',

    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                '📋 Матчи',

              callback_data:
                'tiadm:matches'
            },

            {
              text:
                '⚙️ Admin',

              callback_data:
                'tiadm:menu'
            }
          ]
        ]
      }
    }
  );
}


// ==================================================
// ADMIN — CALLBACKS
// ==================================================

async function handleTiAdminCallback(
  query,
  data
) {
  const chatId =
    query.message?.chat?.id;


  if (!chatId) {
    return;
  }


  // Любой admin callback
  // повторно проверяет Telegram ID.

  if (
    !await requireTelegramAdmin(
      chatId,
      query.from.id
    )
  ) {
    return;
  }


  // ------------------------------------------------
  // MENU
  // ------------------------------------------------

  if (
    data ===
    'tiadm:menu'
  ) {
    await showTiAdminMenu(
      chatId
    );


    return;
  }


  // ------------------------------------------------
  // RATING EXCLUSION GROUPS
  // ------------------------------------------------

  if (
    data ===
    'tiadm:rgroups'
  ) {
    await showTiAdminRatingGroups(
      chatId
    );


    return;
  }


  if (
    data?.startsWith(
      'tiadm:rgroup:set:'
    )
  ) {
    const parts =
      data.split(':');


    const userId =
      Number(
        parts[3]
      );


    const ratingGroup =
      parts[4];


    if (
      !userId ||
      !ratingGroup
    ) {
      return;
    }


    await setTiAdminRatingGroup(
      chatId,
      userId,
      ratingGroup
    );


    return;
  }


  if (
    data?.startsWith(
      'tiadm:rgroup:'
    )
  ) {
    const userId =
      Number(
        data.split(':')[2]
      );


    if (!userId) {
      return;
    }


    await showTiAdminRatingGroupUser(
      chatId,
      userId
    );


    return;
  }


  // ------------------------------------------------
  // REGISTRATIONS
  // ------------------------------------------------

  if (
    data ===
    'tiadm:registrations'
  ) {
    await showTiAdminRegistrations(
      chatId
    );


    return;
  }


  if (
    data?.startsWith(
      'tiadm:reg:approve:'
    )
  ) {
    const userId =
      Number(
        data.split(':')[3]
      );


    if (!userId) {
      return;
    }


    await approveTiRegistrationFromAdmin(
      chatId,
      userId,
      query.from.id
    );


    return;
  }


  if (
    data?.startsWith(
      'tiadm:reg:reject:'
    )
  ) {
    const userId =
      Number(
        data.split(':')[3]
      );


    if (!userId) {
      return;
    }


    await rejectTiRegistrationFromAdmin(
      chatId,
      userId,
      query.from.id
    );


    return;
  }


  if (
    data?.startsWith(
      'tiadm:reg:'
    )
  ) {
    const userId =
      Number(
        data.split(':')[2]
      );


    if (!userId) {
      return;
    }


    await showTiAdminRegistration(
      chatId,
      userId
    );


    return;
  }


  // ------------------------------------------------
  // MATCHES
  // ------------------------------------------------

  if (
    data ===
    'tiadm:matches'
  ) {
    await showTiAdminMatches(
      chatId
    );


    return;
  }


  // ------------------------------------------------
  // BRACKET
  // ------------------------------------------------

  if (
    data ===
    'tiadm:bracket'
  ) {
    await showTiAdminBracket(
      chatId
    );


    return;
  }


  // ------------------------------------------------
  // ADMIN MODE ON
  // ------------------------------------------------

  if (
    data ===
    'tiadm:mode:on'
  ) {
    await enableTiAdminMode(
      `telegram:${query.from.id}`
    );


    await showTiAdminMenu(
      chatId
    );


    return;
  }


  // ------------------------------------------------
  // ADMIN MODE OFF
  // ------------------------------------------------

  if (
    data ===
    'tiadm:mode:off'
  ) {
    await disableTiAdminMode();


    await showTiAdminMenu(
      chatId
    );


    return;
  }


  // ------------------------------------------------
  // RESET ALL — ASK
  // ------------------------------------------------

  if (
    data ===
    'tiadm:resetallask'
  ) {
    await showTiAdminResetAllConfirmation(
      chatId
    );


    return;
  }


  // ------------------------------------------------
  // RESET ALL — APPLY
  // ------------------------------------------------

  if (
    data ===
    'tiadm:resetall'
  ) {
    await applyTiAdminResetAll(
      chatId
    );


    return;
  }


  // ------------------------------------------------
  // OPEN MATCH
  //
  // tiadm:match:NODE
  // ------------------------------------------------

  if (
    data?.startsWith(
      'tiadm:match:'
    )
  ) {
    const parts =
      data.split(':');


    const nodeId =
      Number(
        parts[2]
      );


    if (!nodeId) {
      return;
    }


    await showTiAdminMatch(
      chatId,
      nodeId
    );


    return;
  }


  // ------------------------------------------------
  // PICK SCORE
  //
  // tiadm:pick:NODE:A:B
  // ------------------------------------------------

  if (
    data?.startsWith(
      'tiadm:pick:'
    )
  ) {
    const parts =
      data.split(':');


    const nodeId =
      Number(
        parts[2]
      );


    const scoreA =
      Number(
        parts[3]
      );


    const scoreB =
      Number(
        parts[4]
      );


    await showTiAdminResultConfirmation(
      chatId,
      nodeId,
      scoreA,
      scoreB
    );


    return;
  }


  // ------------------------------------------------
  // SET SCORE
  //
  // tiadm:set:NODE:A:B
  // ------------------------------------------------

  if (
    data?.startsWith(
      'tiadm:set:'
    )
  ) {
    const parts =
      data.split(':');


    const nodeId =
      Number(
        parts[2]
      );


    const scoreA =
      Number(
        parts[3]
      );


    const scoreB =
      Number(
        parts[4]
      );


    await applyTiAdminResult(
      chatId,
      nodeId,
      scoreA,
      scoreB
    );


    return;
  }


  // ------------------------------------------------
  // RESET ASK
  //
  // tiadm:resetask:NODE
  // ------------------------------------------------

  if (
    data?.startsWith(
      'tiadm:resetask:'
    )
  ) {
    const parts =
      data.split(':');


    const nodeId =
      Number(
        parts[2]
      );


    await showTiAdminResetConfirmation(
      chatId,
      nodeId
    );


    return;
  }


  // ------------------------------------------------
  // RESET APPLY
  //
  // tiadm:reset:NODE
  // ------------------------------------------------

  if (
    data?.startsWith(
      'tiadm:reset:'
    )
  ) {
    const parts =
      data.split(':');


    const nodeId =
      Number(
        parts[2]
      );


    await applyTiAdminReset(
      chatId,
      nodeId
    );


    return;
  }


  console.log(
    new Date().toISOString(),

    '[TI ADMIN] unknown callback:',

    data
  );
}


// ==================================================
// MESSAGE
// ==================================================

async function handleMessage(
  message
) {
  const chatId =
    message.chat?.id;


  if (!chatId) {
    return;
  }


  if (
    message.contact
  ) {
    await handleTiContact(
      message
    );

    return;
  }


  if (
    message.text ===
      '/admin' ||

    message.text?.startsWith(
      '/admin@'
    )
  ) {
    if (
      !await requireTelegramAdmin(
        chatId,
        message.from.id
      )
    ) {
      return;
    }


    await showTiAdminMenu(
      chatId
    );

    return;
  }


  if (
    message.text ===
      '/privacy' ||

    message.text?.startsWith(
      '/privacy@'
    )
  ) {
    const user =
      await registerTiUser(
        message.from
      );


    await showTiPrivacyMenu(
      chatId,
      user
    );

    return;
  }


  if (
    message.text ===
      '/rules' ||

    message.text?.startsWith(
      '/rules@'
    )
  ) {
    const user =
      await registerTiUser(
        message.from
      );


    await showTiRulesPage(
      chatId,
      user,
      1
    );

    return;
  }


  if (
    message.text ===
      '/menu' ||

    message.text?.startsWith(
      '/menu@'
    ) ||

    message.text ===
      '🏠 Главное меню'
  ) {
    const user =
      await registerTiUser(
        message.from
      );


    const ready =
      await showNextTiRegistrationStep(
        chatId,
        user
      );


    if (!ready) {
      return;
    }


    await showMainMenu(
      chatId
    );

    return;
  }


  if (
    message.text ===
      '/start' ||

    message.text?.startsWith(
      '/start '
    )
  ) {
    const user =
      await registerTiUser(
        message.from
      );


    const ready =
      await showNextTiRegistrationStep(
        chatId,
        user
      );


    if (!ready) {
      return;
    }


    await showMainMenu(
      chatId
    );

    return;
  }
}


// ==================================================
// CALLBACK ACKNOWLEDGE
// ==================================================

async function acknowledgeCallback(
  query
) {
  try {
    await tiTg(
      'answerCallbackQuery',

      {
        callback_query_id:
          query.id
      }
    );

  } catch (err) {
    const message =
      String(
        err?.message ||
        err
      );


    // Старый callback Telegram
    // не должен ломать выполнение
    // самого действия.

    if (
      message.includes(
        'query is too old'
      ) ||

      message.includes(
        'query ID is invalid'
      ) ||

      message.includes(
        'response timeout expired'
      )
    ) {
      console.log(
        new Date().toISOString(),

        '[TI] old callback acknowledgement ignored'
      );


      return;
    }


    console.error(
      new Date().toISOString(),

      '[TI] answerCallbackQuery error:',

      err
    );
  }
}


// ==================================================
// CALLBACK
// ==================================================

async function handleCallback(
  query
) {
  const data =
    query.data;


  const chatId =
    query.message?.chat?.id;


  if (!chatId) {
    return;
  }


  await acknowledgeCallback(
    query
  );


  // ------------------------------------------------
  // ADMIN CALLBACKS
  // ------------------------------------------------

  if (
    data?.startsWith(
      'tiadm:'
    )
  ) {
    await handleTiAdminCallback(
      query,
      data
    );


    return;
  }


  // ------------------------------------------------
  // RULES / LEGAL CALLBACKS
  // ------------------------------------------------

  if (
    data?.startsWith(
      'ti:rules:'
    )
  ) {
    const user =
      await registerTiUser(
        query.from
      );

    const page =
      Number(
        data.split(':')[2]
      ) || 1;

    await showTiRulesPage(
      chatId,
      user,
      page
    );

    return;
  }


  if (
    data ===
      'ti:legal:continue'
  ) {
    const user =
      await registerTiUser(
        query.from
      );

    const ready =
      await showNextTiRegistrationStep(
        chatId,
        user
      );

    if (ready) {
      await showMainMenu(
        chatId
      );
    }

    return;
  }


  if (
    data ===
      'ti:legal:rules:accept'
  ) {
    await registerTiUser(
      query.from
    );

    await acceptTiRulesAndContinue(
      chatId,
      query.from.id
    );

    return;
  }


  if (
    data ===
      'ti:legal:rules:decline'
  ) {
    await showTiLegalDeclined(
      chatId,
      'rules'
    );

    return;
  }


  if (
    data ===
      'ti:legal:privacy:accept'
  ) {
    await registerTiUser(
      query.from
    );

    await acceptTiPrivacyAndContinue(
      chatId,
      query.from.id
    );

    return;
  }


  if (
    data ===
      'ti:legal:privacy:decline'
  ) {
    await showTiLegalDeclined(
      chatId,
      'privacy'
    );

    return;
  }


  if (
    data?.startsWith(
      'ti:legal:name:set:'
    )
  ) {
    await registerTiUser(
      query.from
    );

    const mode =
      data.split(':')[4];

    if (
      mode !== 'name' &&
      mode !== 'pseudonym'
    ) {
      return;
    }

    await setTiInitialRatingNameModeAndContinue(
      chatId,
      query.from.id,
      mode
    );

    return;
  }


  // ------------------------------------------------
  // PRIVACY CALLBACKS
  // ------------------------------------------------

  if (
    data ===
    'ti:privacy'
  ) {
    const user =
      await registerTiUser(
        query.from
      );


    await showTiPrivacyMenu(
      chatId,
      user
    );


    return;
  }


  if (
    data ===
      'ti:privacy:name:change'
  ) {
    const user =
      await registerTiUser(
        query.from
      );

    if (
      !hasCurrentTiPrivacyConsent(
        user
      )
    ) {
      await showNextTiRegistrationStep(
        chatId,
        user
      );

      return;
    }

    await showTiPublicationChoice(
      chatId,
      {
        fromPrivacy: true
      }
    );

    return;
  }


  if (
    data?.startsWith(
      'ti:privacy:name:set:'
    )
  ) {
    const user =
      await registerTiUser(
        query.from
      );

    if (
      hasTiPrivacyWithdrawal(
        user
      )
    ) {
      await showTiPrivacyWithdrawn(
        chatId,
        user
      );

      return;
    }

    const mode =
      data.split(':')[4];

    if (
      mode !== 'name' &&
      mode !== 'pseudonym'
    ) {
      return;
    }

    await setTiRatingNameMode({
      telegramId:
        query.from.id,
      mode,
      version:
        TI_PUBLICATION_VERSION
    });

    const updated =
      await getTiUserByTelegramId(
        query.from.id
      );

    await showTiPrivacyMenu(
      chatId,
      updated
    );

    return;
  }


  if (
    data ===
    'ti:privacy:revoke:ask'
  ) {
    const user =
      await registerTiUser(
        query.from
      );


    if (
      hasTiPrivacyWithdrawal(
        user
      )
    ) {
      await showTiPrivacyWithdrawn(
        chatId,
        user
      );

      return;
    }


    if (
      !hasCurrentTiPrivacyConsent(
        user
      )
    ) {
      await showNextTiRegistrationStep(
        chatId,
        user
      );

      return;
    }


    await showTiPrivacyRevokeConfirmation(
      chatId
    );


    return;
  }


  if (
    data ===
    'ti:privacy:revoke:confirm'
  ) {
    const user =
      await registerTiUser(
        query.from
      );


    if (
      !hasCurrentTiPrivacyConsent(
        user
      )
    ) {
      await showNextTiRegistrationStep(
        chatId,
        user
      );

      return;
    }


    await confirmTiPrivacyWithdrawal(
      chatId,
      query.from.id
    );


    return;
  }


  // ------------------------------------------------
  // BLOCK USER ACTIONS AFTER PRIVACY WITHDRAWAL
  // ------------------------------------------------

  const callbackUser =
    await registerTiUser(
      query.from
    );


  if (
    hasTiPrivacyWithdrawal(
      callbackUser
    )
  ) {
    await showTiPrivacyWithdrawn(
      chatId,
      callbackUser
    );

    return;
  }


  const callbackReady =
    await showNextTiRegistrationStep(
      chatId,
      callbackUser
    );


  if (!callbackReady) {
    return;
  }


  // ------------------------------------------------
  // MAIN MENU
  // ------------------------------------------------

  if (
    data ===
    'ti:menu'
  ) {
    await showMainMenu(
      chatId
    );

    return;
  }


  // ------------------------------------------------
  // BRACKET
  // ------------------------------------------------

  if (
    data ===
    'ti:bracket'
  ) {
    await showTiBracket(
      chatId
    );


    return;
  }


  // ------------------------------------------------
  // PREDICTION MENU
  // ------------------------------------------------

  if (
    data ===
    'ti:predict'
  ) {
    await showPredictionMatches(
      chatId,
      query.from.id
    );


    return;
  }


  // ------------------------------------------------
  // MATCHES
  // ------------------------------------------------

  if (
    data ===
    'ti:matches'
  ) {
    await showMatches(
      chatId
    );


    return;
  }


  // ------------------------------------------------
  // MY PREDICTIONS
  // ------------------------------------------------

  if (
    data ===
    'ti:my'
  ) {
    await showMyPredictions(
      chatId,
      query.from.id
    );


    return;
  }


  // ------------------------------------------------
  // RATING
  // ------------------------------------------------

  if (
    data ===
    'ti:rating'
  ) {
    await showRating(
      chatId,
      query.from.id
    );


    return;
  }


  // ------------------------------------------------
  // BET
  //
  // ti:bet:MATCH_ID:TEAM_ID
  // ------------------------------------------------

  if (
    data?.startsWith(
      'ti:bet:'
    )
  ) {
    const parts =
      data.split(':');


    const matchId =
      Number(
        parts[2]
      );


    const teamId =
      Number(
        parts[3]
      );


    if (
      !matchId ||
      !teamId
    ) {
      await tiSend(
        chatId,
        '❌ Ошибка данных прогноза.'
      );


      return;
    }


    await makePrediction(
      query,
      matchId,
      teamId
    );


    return;
  }


  console.log(
    new Date().toISOString(),

    '[TI] unknown callback:',

    data
  );
}


// ==================================================
// UPDATE
// ==================================================

async function handleUpdate(
  update
) {
  if (
    update.message
  ) {
    await handleMessage(
      update.message
    );
  }


  if (
    update.callback_query
  ) {
    await handleCallback(
      update.callback_query
    );
  }
}


// ==================================================
// REGULAR GIZMO PROFILE SYNC
//
// Не создаём отдельный worker/process.
// Синхронизация живёт внутри уже существующего
// tiBotWorker, который контролируется supervisor.
//
// Период: 15 минут. При открытии админской
// карточки всё равно выполняется немедленный refresh.
// ==================================================

const TI_GIZMO_PROFILE_SYNC_MS =
  15 * 60 * 1000;


let tiGizmoProfileSyncRunning =
  false;


async function runTiGizmoProfileSync(
  source = 'timer'
) {
  if (tiGizmoProfileSyncRunning) {
    return;
  }


  tiGizmoProfileSyncRunning =
    true;


  try {
    const result =
      await refreshTiRegistrations({
        force: true
      });


    console.log(
      new Date().toISOString(),
      '[TI REG] Gizmo sync',
      `source=${source}`,
      `total=${result.total}`,
      `exact=${result.exact}`,
      `multiple=${result.multiple}`,
      `not_found=${result.notFound}`
    );

  } catch (err) {
    console.error(
      new Date().toISOString(),
      '[TI REG] Gizmo sync error:',
      err
    );

  } finally {
    tiGizmoProfileSyncRunning =
      false;
  }
}


function startTiGizmoProfileSync() {
  // Первый проход после старта — через 20 секунд,
  // чтобы не мешать запуску polling.
  setTimeout(
    () => {
      void runTiGizmoProfileSync(
        'startup'
      );
    },
    20_000
  );


  setInterval(
    () => {
      void runTiGizmoProfileSync(
        'timer'
      );
    },
    TI_GIZMO_PROFILE_SYNC_MS
  );
}


// ==================================================
// POLLING
// ==================================================

async function poll() {
  console.log(
    new Date().toISOString(),
    'TI bot worker started'
  );


  while (true) {
    try {
      const updates =
        await tiTg(
          'getUpdates',

          {
            offset,

            timeout:
              30,

            allowed_updates:
              JSON.stringify([
                'message',
                'callback_query'
              ])
          }
        );


      for (
        const update
        of updates
      ) {
        // Offset двигаем ДО обработки.
        //
        // Если конкретный update
        // приведёт к ошибке,
        // бот не зациклится на нём.

        offset =
          update.update_id + 1;


        try {
          await handleUpdate(
            update
          );

        } catch (err) {
          console.error(
            new Date().toISOString(),

            'TI update error:',

            err
          );
        }
      }

    } catch (err) {
      console.error(
        new Date().toISOString(),

        'TI polling error:',

        err
      );


      await sleep(
        5000
      );
    }
  }
}


// ==================================================
// START
// ==================================================

startTiGizmoProfileSync();


poll()
  .catch(
    err => {
      console.error(
        new Date().toISOString(),

        'TI fatal:',

        err
      );


      process.exit(
        1
      );
    }
  );