import { q } from './db.js';


export const TI_LEAGUE_ID =
  19719;


// ==================================================
// REWARD GROUPS
// ==================================================

export const TI_REWARD_GROUPS = {

  BASE:
    'base',

  FINALS:
    'finals',

  GRAND_FINAL:
    'grand_final'

};


// ==================================================
// GROUP TITLES
// ==================================================

export const TI_REWARD_GROUP_TITLES = {

  base:
    'Обычные матчи',

  finals:
    'Финалы сеток',

  grand_final:
    'Grand Final'

};


// ==================================================
// NODE -> REWARD GROUP
//
// node 20 = Upper Final
// node 27 = Lower Final
// node 21 = Grand Final
//
// Остальные playoff nodes = base
// ==================================================

export function getTiRewardGroupForNode(
  nodeId
) {

  const id =
    Number(
      nodeId
    );


  if (
    id === 21
  ) {

    return TI_REWARD_GROUPS
      .GRAND_FINAL;

  }


  if (
    id === 20 ||
    id === 27
  ) {

    return TI_REWARD_GROUPS
      .FINALS;

  }


  return TI_REWARD_GROUPS
    .BASE;

}


// ==================================================
// VALIDATE GROUP
// ==================================================

function normalizeRewardGroup(
  rewardGroup
) {

  const group =
    String(
      rewardGroup || ''
    ).trim();


  const allowed =
    new Set(
      Object.values(
        TI_REWARD_GROUPS
      )
    );


  if (
    !allowed.has(
      group
    )
  ) {

    throw new Error(
      `Invalid TI reward group: ${rewardGroup}`
    );

  }


  return group;

}


// ==================================================
// VALIDATE INTEGER
// ==================================================

function normalizeUnsignedInteger(
  value,
  name
) {

  const number =
    Number(
      value
    );


  if (
    !Number.isInteger(
      number
    ) ||
    number < 0
  ) {

    throw new Error(
      `Invalid ${name}: ${value}`
    );

  }


  return number;

}


// ==================================================
// GET ALL CONFIG
// ==================================================

export async function getTiRewardConfig() {

  const rows =
    await q(
      `
        SELECT
          reward_group,
          title,
          points,
          bonus_rub,
          updated_at

        FROM ti_reward_config

        ORDER BY
          CASE reward_group

            WHEN 'base'
              THEN 1

            WHEN 'finals'
              THEN 2

            WHEN 'grand_final'
              THEN 3

            ELSE 99

          END
      `
    );


  return rows;

}


// ==================================================
// GET ONE GROUP
// ==================================================

export async function getTiRewardConfigByGroup(
  rewardGroup
) {

  const group =
    normalizeRewardGroup(
      rewardGroup
    );


  const rows =
    await q(
      `
        SELECT
          reward_group,
          title,
          points,
          bonus_rub,
          updated_at

        FROM ti_reward_config

        WHERE reward_group = ?

        LIMIT 1
      `,
      [
        group
      ]
    );


  if (
    !rows.length
  ) {

    throw new Error(
      `TI reward config not found: ${group}`
    );

  }


  return rows[0];

}


// ==================================================
// GET REWARD FOR NODE
// ==================================================

export async function getTiRewardForNode(
  nodeId
) {

  const rewardGroup =
    getTiRewardGroupForNode(
      nodeId
    );


  const config =
    await getTiRewardConfigByGroup(
      rewardGroup
    );


  return {

    rewardGroup,

    title:
      config.title,

    points:
      Number(
        config.points
      ),

    bonusRub:
      Number(
        config.bonus_rub
      )

  };

}


// ==================================================
// SQL CONDITION FOR GROUP
// ==================================================

function getGroupSqlCondition(
  rewardGroup
) {

  switch (
    rewardGroup
  ) {

    case TI_REWARD_GROUPS.BASE:

      return `
        source_match_id NOT IN (20, 21, 27)
      `;


    case TI_REWARD_GROUPS.FINALS:

      return `
        source_match_id IN (20, 27)
      `;


    case TI_REWARD_GROUPS.GRAND_FINAL:

      return `
        source_match_id = 21
      `;


    default:

      throw new Error(
        `Unknown reward group: ${rewardGroup}`
      );

  }

}


// ==================================================
// UPDATE CONFIG
//
// ВАЖНО:
//
// Меняем:
//   1. ti_reward_config
//   2. только scheduled матчи
//
// finished/live матчи не трогаем.
// ==================================================

export async function updateTiRewardConfig(
  rewardGroup,
  {
    points,
    bonusRub
  }
) {

  const group =
    normalizeRewardGroup(
      rewardGroup
    );


  const normalizedPoints =
    normalizeUnsignedInteger(
      points,
      'points'
    );


  const normalizedBonusRub =
    normalizeUnsignedInteger(
      bonusRub,
      'bonusRub'
    );


  await q(
    `
      UPDATE ti_reward_config

      SET
        points = ?,
        bonus_rub = ?,
        updated_at =
          CURRENT_TIMESTAMP

      WHERE reward_group = ?
    `,
    [
      normalizedPoints,
      normalizedBonusRub,
      group
    ]
  );


  const condition =
    getGroupSqlCondition(
      group
    );


  // ------------------------------------------------
  // Обновляем snapshot награды
  // только для scheduled матчей.
  // ------------------------------------------------

  await q(
    `
      UPDATE ti_matches

      SET
        reward_group = ?,
        points = ?,
        bonus_rub = ?,
        updated_at =
          CURRENT_TIMESTAMP

      WHERE
        league_id = ?

        AND status = 'scheduled'

        AND (
          ${condition}
        )
    `,
    [
      group,
      normalizedPoints,
      normalizedBonusRub,
      TI_LEAGUE_ID
    ]
  );


  return getTiRewardConfigByGroup(
    group
  );

}


// ==================================================
// APPLY CURRENT CONFIG TO ONE MATCH
//
// Используется при создании нового node.
//
// Награда становится snapshot'ом
// внутри ti_matches.
// ==================================================

export async function applyTiRewardToMatch(
  matchId,
  nodeId
) {

  const id =
    Number(
      matchId
    );


  if (
    !Number.isInteger(id) ||
    id <= 0
  ) {

    throw new Error(
      `Invalid matchId: ${matchId}`
    );

  }


  const reward =
    await getTiRewardForNode(
      nodeId
    );


  await q(
    `
      UPDATE ti_matches

      SET
        reward_group = ?,
        points = ?,
        bonus_rub = ?,
        updated_at =
          CURRENT_TIMESTAMP

      WHERE
        id = ?
        AND status = 'scheduled'
    `,
    [
      reward.rewardGroup,
      reward.points,
      reward.bonusRub,
      id
    ]
  );


  return reward;

}


// ==================================================
// SYNC ALL SCHEDULED MATCH REWARDS
//
// Полезно для теста / ручной синхронизации.
// ==================================================

export async function syncTiScheduledRewards() {

  const config =
    await getTiRewardConfig();


  const configMap =
    new Map();


  for (
    const row
    of config
  ) {

    configMap.set(
      row.reward_group,
      {
        points:
          Number(
            row.points
          ),

        bonusRub:
          Number(
            row.bonus_rub
          )
      }
    );

  }


  const matches =
    await q(
      `
        SELECT
          id,
          source_match_id

        FROM ti_matches

        WHERE
          league_id = ?
          AND status = 'scheduled'
      `,
      [
        TI_LEAGUE_ID
      ]
    );


  let updated =
    0;


  for (
    const match
    of matches
  ) {

    const rewardGroup =
      getTiRewardGroupForNode(
        match.source_match_id
      );


    const reward =
      configMap.get(
        rewardGroup
      );


    if (!reward) {

      throw new Error(
        `Reward config missing: ${rewardGroup}`
      );

    }


    await q(
      `
        UPDATE ti_matches

        SET
          reward_group = ?,
          points = ?,
          bonus_rub = ?,
          updated_at =
            CURRENT_TIMESTAMP

        WHERE id = ?
      `,
      [
        rewardGroup,
        reward.points,
        reward.bonusRub,
        match.id
      ]
    );


    updated += 1;

  }


  return {
    updated
  };

}