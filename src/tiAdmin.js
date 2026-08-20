import { pool } from './db.js';

import {
  getTiRewardForNode
} from './tiRewards.js';


// ==================================================
// CONSTANTS
// ==================================================

export const TI_LEAGUE_ID =
  19719;


// ==================================================
// PLAYOFF NODES
// ==================================================

const PLAYOFF_NODES =
  new Set([
    14,
    15,
    16,
    17,

    18,
    19,

    20,
    21,

    22,
    23,

    24,
    25,

    26,
    27
  ]);


const PLAYOFF_SOURCE_NODES =
  [
    14,
    15,
    16,
    17
  ];


// ==================================================
// PLAYOFF START TIMES
// ==================================================

const PLAYOFF_START_TIMES =
  new Map([
    [14, 1787191200],
    [15, 1787202000],
    [16, 1787212800],
    [17, 1787223600],

    [22, 1787277600],
    [23, 1787288400],

    [18, 1787299200],
    [19, 1787310000],

    [25, 1787364000],
    [24, 1787374800],

    [20, 1787385600],
    [26, 1787396400],

    [27, 1787450400],

    [21, 1787461200]
  ]);


// ==================================================
// BRACKET ROUTES
//
// slot A = team_a
// slot B = team_b
// ==================================================

const BRACKET_ROUTES =
  new Map([

    [
      14,
      {
        winner: {
          nodeId: 18,
          slot: 'A'
        },

        loser: {
          nodeId: 22,
          slot: 'A'
        }
      }
    ],

    [
      15,
      {
        winner: {
          nodeId: 18,
          slot: 'B'
        },

        loser: {
          nodeId: 22,
          slot: 'B'
        }
      }
    ],

    [
      16,
      {
        winner: {
          nodeId: 19,
          slot: 'A'
        },

        loser: {
          nodeId: 23,
          slot: 'A'
        }
      }
    ],

    [
      17,
      {
        winner: {
          nodeId: 19,
          slot: 'B'
        },

        loser: {
          nodeId: 23,
          slot: 'B'
        }
      }
    ],

    [
      18,
      {
        winner: {
          nodeId: 20,
          slot: 'A'
        },

        loser: {
          nodeId: 25,
          slot: 'A'
        }
      }
    ],

    [
      19,
      {
        winner: {
          nodeId: 20,
          slot: 'B'
        },

        loser: {
          nodeId: 24,
          slot: 'A'
        }
      }
    ],

    [
      20,
      {
        winner: {
          nodeId: 21,
          slot: 'A'
        },

        loser: {
          nodeId: 27,
          slot: 'A'
        }
      }
    ],

    [
      22,
      {
        winner: {
          nodeId: 24,
          slot: 'B'
        },

        loser:
          null
      }
    ],

    [
      23,
      {
        winner: {
          nodeId: 25,
          slot: 'B'
        },

        loser:
          null
      }
    ],

    [
      24,
      {
        winner: {
          nodeId: 26,
          slot: 'A'
        },

        loser:
          null
      }
    ],

    [
      25,
      {
        winner: {
          nodeId: 26,
          slot: 'B'
        },

        loser:
          null
      }
    ],

    [
      26,
      {
        winner: {
          nodeId: 27,
          slot: 'B'
        },

        loser:
          null
      }
    ],

    [
      27,
      {
        winner: {
          nodeId: 21,
          slot: 'B'
        },

        loser:
          null
      }
    ],

    [
      21,
      {
        winner:
          null,

        loser:
          null
      }
    ]

  ]);


// ==================================================
// HELPERS
// ==================================================

function normalizeNodeId(
  value
) {

  const nodeId =
    Number(
      value
    );


  if (
    !Number.isInteger(nodeId) ||
    !PLAYOFF_NODES.has(nodeId)
  ) {

    throw new Error(
      `Invalid playoff node: ${value}`
    );

  }


  return nodeId;
}


function normalizeScore(
  value,
  name
) {

  const score =
    Number(
      value
    );


  if (
    !Number.isInteger(score) ||
    score < 0
  ) {

    throw new Error(
      `Invalid ${name}: ${value}`
    );

  }


  return score;
}


function getSlotColumns(
  slot
) {

  if (
    slot === 'A'
  ) {

    return {

      idColumn:
        'team_a_id',

      nameColumn:
        'team_a_name'

    };

  }


  if (
    slot === 'B'
  ) {

    return {

      idColumn:
        'team_b_id',

      nameColumn:
        'team_b_name'

    };

  }


  throw new Error(
    `Invalid bracket slot: ${slot}`
  );
}


function matchHasResult(
  match
) {

  if (!match) {
    return false;
  }


  return (
    match.status === 'finished' ||

    match.status === 'live' ||

    match.score_a !== null ||

    match.score_b !== null ||

    match.winner_team_id !== null
  );
}


// ==================================================
// UNIX -> MYSQL / MOSCOW
// ==================================================

function timestampToMysql(
  timestamp
) {

  if (!timestamp) {
    return null;
  }


  const date =
    new Date(
      Number(timestamp) * 1000
    );


  const parts =
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone:
          'Europe/Moscow',

        year:
          'numeric',

        month:
          '2-digit',

        day:
          '2-digit',

        hour:
          '2-digit',

        minute:
          '2-digit',

        second:
          '2-digit',

        hour12:
          false
      }
    ).formatToParts(
      date
    );


  const get =
    type =>
      parts.find(
        part =>
          part.type === type
      )?.value;


  return (
    `${get('year')}-` +
    `${get('month')}-` +
    `${get('day')} ` +
    `${get('hour')}:` +
    `${get('minute')}:` +
    `${get('second')}`
  );
}


// ==================================================
// REQUIRED WINS
// ==================================================

export function getRequiredWins(
  nodeId
) {

  const id =
    normalizeNodeId(
      nodeId
    );


  if (
    id === 21
  ) {

    return 3;

  }


  return 2;
}


// ==================================================
// SCORE VALIDATION
// ==================================================

function validateFinishedScore(
  nodeId,
  scoreA,
  scoreB
) {

  const requiredWins =
    getRequiredWins(
      nodeId
    );


  const aWins =
    scoreA ===
    requiredWins;


  const bWins =
    scoreB ===
    requiredWins;


  if (
    aWins === bWins
  ) {

    throw new Error(
      `Invalid finished score for node ${nodeId}: ` +
      `${scoreA}:${scoreB}. ` +
      `Winner must have exactly ${requiredWins} wins.`
    );

  }


  const loserScore =
    aWins
      ? scoreB
      : scoreA;


  if (
    loserScore >=
    requiredWins
  ) {

    throw new Error(
      `Invalid loser score for node ${nodeId}: ` +
      `${scoreA}:${scoreB}`
    );

  }


  return {

    requiredWins,

    winnerSide:
      aWins
        ? 'A'
        : 'B'

  };
}


// ==================================================
// GET MATCH
// ==================================================

export async function getTiAdminMatch(
  nodeId
) {

  const id =
    normalizeNodeId(
      nodeId
    );


  const [rows] =
    await pool.query(
      `
        SELECT *

        FROM ti_matches

        WHERE
          league_id = ?
          AND source_match_id = ?

        LIMIT 1
      `,
      [
        TI_LEAGUE_ID,
        id
      ]
    );


  return (
    rows[0] ||
    null
  );
}


// ==================================================
// LIST PLAYOFF MATCHES
// ==================================================

export async function getTiAdminMatches() {

  const [rows] =
    await pool.query(
      `
        SELECT
          id,
          source_match_id,

          team_a_id,
          team_a_name,

          team_b_id,
          team_b_name,

          start_time,
          status,

          reward_group,
          points,
          bonus_rub,

          score_a,
          score_b,

          winner_team_id,

          betting_closed

        FROM ti_matches

        WHERE
          league_id = ?
          AND source_match_id BETWEEN 14 AND 27

        ORDER BY
          source_match_id ASC
      `,
      [
        TI_LEAGUE_ID
      ]
    );


  return rows;
}


// ==================================================
// GET MATCH FOR UPDATE
// ==================================================

async function getMatchForUpdate(
  connection,
  nodeId
) {

  const [rows] =
    await connection.query(
      `
        SELECT *

        FROM ti_matches

        WHERE
          league_id = ?
          AND source_match_id = ?

        LIMIT 1

        FOR UPDATE
      `,
      [
        TI_LEAGUE_ID,
        nodeId
      ]
    );


  return (
    rows[0] ||
    null
  );
}


// ==================================================
// CREATE DESTINATION NODE
// ==================================================

async function createDestinationMatch(
  connection,
  nodeId
) {

  const startUnix =
    PLAYOFF_START_TIMES.get(
      nodeId
    );


  if (!startUnix) {

    throw new Error(
      `Start time not found for node=${nodeId}`
    );

  }


  const startTime =
    timestampToMysql(
      startUnix
    );


  // ------------------------------------------------
  // Награда нового node
  // ------------------------------------------------

  const reward =
    await getTiRewardForNode(
      nodeId
    );


  await connection.query(
    `
      INSERT INTO ti_matches (

        source_match_id,

        league_id,

        team_a_id,
        team_a_name,

        team_b_id,
        team_b_name,

        start_time,

        status,

        reward_group,
        points,
        bonus_rub,

        betting_closed,

        score_a,
        score_b,

        winner_team_id
      )

      VALUES (

        ?,

        ?,

        NULL,
        '',

        NULL,
        '',

        ?,

        'scheduled',

        ?,
        ?,
        ?,

        1,

        NULL,
        NULL,

        NULL
      )

      ON DUPLICATE KEY UPDATE

        source_match_id =
          VALUES(source_match_id)
    `,
    [
      nodeId,

      TI_LEAGUE_ID,

      startTime,

      reward.rewardGroup,
      reward.points,
      reward.bonusRub
    ]
  );


  return getMatchForUpdate(
    connection,
    nodeId
  );
}


// ==================================================
// UPDATE BETTING STATE
// ==================================================

async function updateBettingState(
  connection,
  matchId
) {

  await connection.query(
    `
      UPDATE ti_matches

      SET
        betting_closed =
          CASE

            WHEN
              team_a_id IS NOT NULL
              AND team_b_id IS NOT NULL
              AND start_time IS NOT NULL
              AND start_time > NOW()

            THEN 0

            ELSE 1

          END,

        updated_at =
          CURRENT_TIMESTAMP

      WHERE id = ?
    `,
    [
      matchId
    ]
  );
}


// ==================================================
// PUT TEAM INTO DESTINATION NODE
// ==================================================

async function putTeamIntoNode(
  connection,
  route,
  team,
  context
) {

  if (
    !route ||
    !route.nodeId
  ) {

    return null;

  }


  const destinationNodeId =
    Number(
      route.nodeId
    );


  const {
    idColumn,
    nameColumn
  } =
    getSlotColumns(
      route.slot
    );


  let destination =
    await getMatchForUpdate(
      connection,
      destinationNodeId
    );


  if (!destination) {

    destination =
      await createDestinationMatch(
        connection,
        destinationNodeId
      );

  }


  if (!destination) {

    throw new Error(
      `Cannot create destination node=${destinationNodeId}`
    );

  }


  const currentTeamId =
    destination[idColumn]
      ? Number(
          destination[idColumn]
        )
      : null;


  // ------------------------------------------------
  // Уже та же команда.
  // ------------------------------------------------

  if (
    currentTeamId ===
    Number(team.id)
  ) {

    if (
      destination[nameColumn] !==
      team.name
    ) {

      await connection.query(
        `
          UPDATE ti_matches

          SET
            ${nameColumn} = ?,

            updated_at =
              CURRENT_TIMESTAMP

          WHERE id = ?
        `,
        [
          team.name,
          destination.id
        ]
      );

    }


    return destination;
  }


  // ------------------------------------------------
  // Слот занят другой командой.
  // ------------------------------------------------

  if (
    currentTeamId &&
    currentTeamId !==
    Number(team.id)
  ) {

    throw new Error(
      `Destination node=${destinationNodeId} ` +
      `slot=${route.slot} already contains ` +
      `team_id=${currentTeamId}`
    );

  }


  // ------------------------------------------------
  // Нельзя добавлять новую команду
  // в сыгранный матч без cascade reset.
  // ------------------------------------------------

  if (
    matchHasResult(
      destination
    )
  ) {

    throw new Error(
      `Destination node=${destinationNodeId} ` +
      `already has a result`
    );

  }


  await connection.query(
    `
      UPDATE ti_matches

      SET
        ${idColumn} = ?,
        ${nameColumn} = ?,

        status = 'scheduled',

        score_a = NULL,
        score_b = NULL,

        winner_team_id = NULL,

        updated_at =
          CURRENT_TIMESTAMP

      WHERE id = ?
    `,
    [
      Number(
        team.id
      ),

      team.name,

      destination.id
    ]
  );


  await updateBettingState(
    connection,
    destination.id
  );


  context.affectedNodes.add(
    destinationNodeId
  );


  return getMatchForUpdate(
    connection,
    destinationNodeId
  );
}


// ==================================================
// CLEAR OUTPUTS OF NODE
// ==================================================

async function clearNodeOutputsCascade(
  connection,
  nodeId,
  context
) {

  const routes =
    BRACKET_ROUTES.get(
      Number(
        nodeId
      )
    );


  if (!routes) {
    return;
  }


  if (
    routes.winner
  ) {

    await clearDestinationSlotCascade(
      connection,
      routes.winner,
      context
    );

  }


  if (
    routes.loser
  ) {

    await clearDestinationSlotCascade(
      connection,
      routes.loser,
      context
    );

  }
}


// ==================================================
// CLEAR DESTINATION SLOT + CASCADE
// ==================================================

async function clearDestinationSlotCascade(
  connection,
  route,
  context
) {

  if (
    !route ||
    !route.nodeId
  ) {

    return;

  }


  const destinationNodeId =
    Number(
      route.nodeId
    );


  const key =
    `${destinationNodeId}:${route.slot}`;


  if (
    context.visitedSlots.has(
      key
    )
  ) {

    return;

  }


  context.visitedSlots.add(
    key
  );


  const {
    idColumn,
    nameColumn
  } =
    getSlotColumns(
      route.slot
    );


  const destination =
    await getMatchForUpdate(
      connection,
      destinationNodeId
    );


  if (!destination) {
    return;
  }


  const currentTeamId =
    destination[idColumn]
      ? Number(
          destination[idColumn]
        )
      : null;


  const currentTeamName =
    String(
      destination[nameColumn] ||
      ''
    );


  const hadResult =
    matchHasResult(
      destination
    );


  if (
    hadResult
  ) {

    await clearNodeOutputsCascade(
      connection,
      destinationNodeId,
      context
    );

  }


  if (
    !currentTeamId &&
    !currentTeamName &&
    !hadResult
  ) {

    return;

  }


  await connection.query(
    `
      UPDATE ti_matches

      SET
        ${idColumn} = NULL,
        ${nameColumn} = '',

        score_a = NULL,
        score_b = NULL,

        winner_team_id = NULL,

        status = 'scheduled',

        betting_closed = 1,

        updated_at =
          CURRENT_TIMESTAMP

      WHERE id = ?
    `,
    [
      destination.id
    ]
  );


  context.affectedNodes.add(
    destinationNodeId
  );
}


// ==================================================
// RESET CURRENT MATCH RESULT
// ==================================================

async function resetCurrentMatchResult(
  connection,
  matchId
) {

  await connection.query(
    `
      UPDATE ti_matches

      SET
        score_a = NULL,
        score_b = NULL,

        winner_team_id = NULL,

        status = 'scheduled',

        betting_closed =
          CASE

            WHEN
              team_a_id IS NOT NULL
              AND team_b_id IS NOT NULL
              AND start_time IS NOT NULL
              AND start_time > NOW()

            THEN 0

            ELSE 1

          END,

        updated_at =
          CURRENT_TIMESTAMP

      WHERE id = ?
    `,
    [
      matchId
    ]
  );
}


// ==================================================
// RESET NODE + CASCADE
// ==================================================

async function resetNodeAndCascade(
  connection,
  nodeId,
  context,
  {
    required = true
  } = {}
) {

  const match =
    await getMatchForUpdate(
      connection,
      nodeId
    );


  if (!match) {

    if (required) {

      throw new Error(
        `Match node=${nodeId} not found in ti_matches`
      );

    }


    return null;
  }


  await clearNodeOutputsCascade(
    connection,
    nodeId,
    context
  );


  await resetCurrentMatchResult(
    connection,
    match.id
  );


  context.affectedNodes.add(
    Number(
      nodeId
    )
  );


  return match;
}


// ==================================================
// PROPAGATE RESULT
// ==================================================

async function propagateResult(
  connection,
  nodeId,
  winner,
  loser,
  context
) {

  const routes =
    BRACKET_ROUTES.get(
      Number(
        nodeId
      )
    );


  if (!routes) {
    return;
  }


  if (
    routes.winner
  ) {

    await putTeamIntoNode(
      connection,
      routes.winner,
      winner,
      context
    );

  }


  if (
    routes.loser
  ) {

    await putTeamIntoNode(
      connection,
      routes.loser,
      loser,
      context
    );

  }
}


// ==================================================
// SET / CHANGE RESULT
// ==================================================

export async function setTiAdminResult({
  nodeId,
  scoreA,
  scoreB
}) {

  const id =
    normalizeNodeId(
      nodeId
    );


  const a =
    normalizeScore(
      scoreA,
      'scoreA'
    );


  const b =
    normalizeScore(
      scoreB,
      'scoreB'
    );


  const validation =
    validateFinishedScore(
      id,
      a,
      b
    );


  const connection =
    await pool.getConnection();


  const context = {

    visitedSlots:
      new Set(),

    affectedNodes:
      new Set()

  };


  try {

    await connection.beginTransaction();


    const match =
      await getMatchForUpdate(
        connection,
        id
      );


    if (!match) {

      throw new Error(
        `Match node=${id} not found in ti_matches`
      );

    }


    if (
      !match.team_a_id ||
      !match.team_b_id
    ) {

      throw new Error(
        `Match node=${id} does not have both teams`
      );

    }


    const teamA = {

      id:
        Number(
          match.team_a_id
        ),

      name:
        match.team_a_name

    };


    const teamB = {

      id:
        Number(
          match.team_b_id
        ),

      name:
        match.team_b_name

    };


    const winner =
      validation.winnerSide === 'A'
        ? teamA
        : teamB;


    const loser =
      validation.winnerSide === 'A'
        ? teamB
        : teamA;


    const sameResult =
      (
        match.status === 'finished' &&

        match.score_a !== null &&
        match.score_b !== null &&

        Number(
          match.score_a
        ) === a &&

        Number(
          match.score_b
        ) === b &&

        Number(
          match.winner_team_id
        ) ===
        Number(
          winner.id
        )
      );


    // ==================================================
    // ТОТ ЖЕ РЕЗУЛЬТАТ
    // ==================================================

    if (
      sameResult
    ) {

      await propagateResult(
        connection,
        id,
        winner,
        loser,
        context
      );


      await connection.commit();


      return {

        nodeId:
          id,

        scoreA:
          a,

        scoreB:
          b,

        teamAId:
          teamA.id,

        teamAName:
          teamA.name,

        teamBId:
          teamB.id,

        teamBName:
          teamB.name,

        winnerTeamId:
          winner.id,

        winnerTeamName:
          winner.name,

        loserTeamId:
          loser.id,

        loserTeamName:
          loser.name,

        unchanged:
          true,

        affectedNodes:
          Array.from(
            context.affectedNodes
          ).sort(
            (x, y) =>
              x - y
          )

      };

    }


    // ==================================================
    // РЕЗУЛЬТАТ ИЗМЕНИЛСЯ
    // ==================================================

    await clearNodeOutputsCascade(
      connection,
      id,
      context
    );


    await connection.query(
      `
        UPDATE ti_matches

        SET
          score_a = ?,
          score_b = ?,

          winner_team_id = ?,

          status = 'finished',

          betting_closed = 1,

          updated_at =
            CURRENT_TIMESTAMP

        WHERE id = ?
      `,
      [
        a,
        b,

        winner.id,

        match.id
      ]
    );


    context.affectedNodes.add(
      id
    );


    await propagateResult(
      connection,
      id,
      winner,
      loser,
      context
    );


    await connection.commit();


    return {

      nodeId:
        id,

      scoreA:
        a,

      scoreB:
        b,

      teamAId:
        teamA.id,

      teamAName:
        teamA.name,

      teamBId:
        teamB.id,

      teamBName:
        teamB.name,

      winnerTeamId:
        winner.id,

      winnerTeamName:
        winner.name,

      loserTeamId:
        loser.id,

      loserTeamName:
        loser.name,

      unchanged:
        false,

      affectedNodes:
        Array.from(
          context.affectedNodes
        ).sort(
          (x, y) =>
            x - y
        )

    };


  } catch (error) {

    try {

      await connection.rollback();

    } catch {
      // ignore
    }


    throw error;


  } finally {

    connection.release();

  }
}


// ==================================================
// RESET RESULT + CASCADE
// ==================================================

export async function resetTiAdminResult(
  nodeId
) {

  const id =
    normalizeNodeId(
      nodeId
    );


  const connection =
    await pool.getConnection();


  const context = {

    visitedSlots:
      new Set(),

    affectedNodes:
      new Set()

  };


  try {

    await connection.beginTransaction();


    const match =
      await resetNodeAndCascade(
        connection,
        id,
        context
      );


    await connection.commit();


    return {

      nodeId:
        id,

      teamAName:
        match.team_a_name,

      teamBName:
        match.team_b_name,

      affectedNodes:
        Array.from(
          context.affectedNodes
        ).sort(
          (x, y) =>
            x - y
        )

    };


  } catch (error) {

    try {

      await connection.rollback();

    } catch {
      // ignore
    }


    throw error;


  } finally {

    connection.release();

  }
}


// ==================================================
// RESET WHOLE PLAYOFF
// ==================================================

export async function resetTiAdminPlayoff() {

  const connection =
    await pool.getConnection();


  const context = {

    visitedSlots:
      new Set(),

    affectedNodes:
      new Set()

  };


  try {

    await connection.beginTransaction();


    for (
      const nodeId
      of PLAYOFF_SOURCE_NODES
    ) {

      await resetNodeAndCascade(
        connection,
        nodeId,
        context,
        {
          required:
            false
        }
      );

    }


    await connection.commit();


    return {

      sourceNodes:
        [
          ...PLAYOFF_SOURCE_NODES
        ],

      affectedNodes:
        Array.from(
          context.affectedNodes
        ).sort(
          (x, y) =>
            x - y
        )

    };


  } catch (error) {

    try {

      await connection.rollback();

    } catch {
      // ignore
    }


    throw error;


  } finally {

    connection.release();

  }
}