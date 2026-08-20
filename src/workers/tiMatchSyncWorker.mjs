import '../env.js';

import { q } from '../db.js';

import {
  isTiAdminMode
} from '../tiAdminMode.js';

import {
  TI_LEAGUE_ID,
  getTiNodes,
  getTiLiveGames,
  getMatchDetails,
  getNodeMatchIds
} from '../tiDotaApi.js';


const SYNC_INTERVAL_MS = 60 * 1000;


// ==================================================
// PLAYOFF FORMAT
//
// Все playoff матчи TI 2026 — BO3,
// Grand Final node=21 — BO5.
//
// Для остальных node формат здесь не угадываем.
// ==================================================

const PLAYOFF_BEST_OF_3_NODE_IDS =
  new Set([
    14,
    15,
    16,
    17,

    18,
    19,

    20,

    22,
    23,

    24,
    25,

    26,
    27
  ]);


function getRequiredWins(nodeId) {
  if (Number(nodeId) === 21) {
    return 3;
  }

  if (
    PLAYOFF_BEST_OF_3_NODE_IDS.has(
      Number(nodeId)
    )
  ) {
    return 2;
  }

  return null;
}


function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


function unixToMysql(unix) {
  if (!unix) {
    return null;
  }

  return new Date(Number(unix) * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}


// ==================================================
// Ищем матч СТРОГО по Valve node_id
// ==================================================

async function getTiMatchByNodeId(nodeId) {
  const rows =
    await q(
      `
        SELECT *
        FROM ti_matches

        WHERE league_id = ?
          AND source_match_id = ?

        LIMIT 1
      `,
      [
        TI_LEAGUE_ID,
        nodeId
      ]
    );

  return rows[0] || null;
}


// ==================================================
// Сохранение отдельной карты
// ==================================================

async function saveGame(
  tiMatch,
  game
) {
  const radiantTeamId =
    Number(
      game.radiant_team_id || 0
    );

  const direTeamId =
    Number(
      game.dire_team_id || 0
    );


  let winnerTeamId = null;


  if (
    game.radiant_win === true
  ) {
    winnerTeamId =
      radiantTeamId;

  } else if (
    game.radiant_win === false
  ) {
    winnerTeamId =
      direTeamId;
  }


  await q(
    `
      INSERT INTO ti_match_games (
        ti_match_id,
        dota_match_id,

        radiant_team_id,
        dire_team_id,

        winner_team_id,

        start_time
      )

      VALUES (
        ?,
        ?,

        ?,
        ?,

        ?,

        ?
      )

      ON DUPLICATE KEY UPDATE

        ti_match_id =
          VALUES(ti_match_id),

        radiant_team_id =
          VALUES(radiant_team_id),

        dire_team_id =
          VALUES(dire_team_id),

        winner_team_id =
          VALUES(winner_team_id),

        start_time =
          VALUES(start_time)
    `,
    [
      tiMatch.id,

      Number(
        game.match_id
      ),

      radiantTeamId,
      direTeamId,

      winnerTeamId,

      unixToMysql(
        game.start_time
      )
    ]
  );
}


// ==================================================
// Счёт по картам Valve
// ==================================================

function calculateSeriesScore(
  tiMatch,
  games
) {
  const teamA =
    Number(
      tiMatch.team_a_id
    );

  const teamB =
    Number(
      tiMatch.team_b_id
    );


  let scoreA = 0;
  let scoreB = 0;


  for (
    const game
    of games
  ) {
    const radiantId =
      Number(
        game.radiant_team_id || 0
      );

    const direId =
      Number(
        game.dire_team_id || 0
      );


    let winner = null;


    if (
      game.radiant_win === true
    ) {
      winner =
        radiantId;

    } else if (
      game.radiant_win === false
    ) {
      winner =
        direId;
    }


    if (
      winner === teamA
    ) {
      scoreA++;
    }


    if (
      winner === teamB
    ) {
      scoreB++;
    }
  }


  return {
    scoreA,
    scoreB
  };
}


// ==================================================
// Live от официального Valve API
//
// league_node_id == source_match_id
// ==================================================

async function syncLiveGame(game) {

  if (
    await isTiAdminMode()
  ) {
    return;
  }


  const nodeId =
    Number(
      game.league_node_id || 0
    );


  if (!nodeId) {
    return;
  }


  const tiMatch =
    await getTiMatchByNodeId(
      nodeId
    );


  if (!tiMatch) {
    console.log(
      `[TI VALVE] live node=${nodeId} not found`
    );

    return;
  }


  if (
    tiMatch.status ===
    'finished'
  ) {
    return;
  }


  const radiantId =
    Number(
      game.radiant_team?.team_id || 0
    );

  const direId =
    Number(
      game.dire_team?.team_id || 0
    );


  const radiantWins =
    Number(
      game.radiant_series_wins || 0
    );

  const direWins =
    Number(
      game.dire_series_wins || 0
    );


  let scoreA =
    Number(
      tiMatch.score_a || 0
    );

  let scoreB =
    Number(
      tiMatch.score_b || 0
    );


  if (
    radiantId ===
    Number(
      tiMatch.team_a_id
    )
  ) {
    scoreA =
      radiantWins;

    scoreB =
      direWins;

  } else if (
    direId ===
    Number(
      tiMatch.team_a_id
    )
  ) {
    scoreA =
      direWins;

    scoreB =
      radiantWins;
  }


  // Admin Mode мог быть включён
  // после загрузки данных.

  if (
    await isTiAdminMode()
  ) {
    return;
  }


  await q(
    `
      UPDATE ti_matches

      SET
        status = 'live',

        betting_closed = 1,

        score_a = ?,
        score_b = ?,

        updated_at =
          CURRENT_TIMESTAMP

      WHERE id = ?
    `,
    [
      scoreA,
      scoreB,

      tiMatch.id
    ]
  );


  console.log(
    `[TI VALVE] LIVE`,
    `node=${nodeId}`,
    `${tiMatch.team_a_name} ${scoreA}:${scoreB} ${tiMatch.team_b_name}`,
    `match=${game.match_id || ''}`
  );
}


// ==================================================
// Статус Valve node
// ==================================================

async function syncNode(node) {

  if (
    await isTiAdminMode()
  ) {
    return;
  }


  const nodeId =
    Number(
      node.node_id || 0
    );


  if (!nodeId) {
    return;
  }


  const tiMatch =
    await getTiMatchByNodeId(
      nodeId
    );


  // Расписание создаёт
  // tiScheduleSyncWorker.
  //
  // Ничего по названиям
  // команд НЕ угадываем.

  if (!tiMatch) {
    return;
  }


  // ----------------------------------------------
  // Ещё не начался
  // ----------------------------------------------

  if (
    !node.has_started &&
    !node.is_completed
  ) {
    return;
  }


  // ----------------------------------------------
  // Уже идёт
  // ----------------------------------------------

  if (
    node.has_started &&
    !node.is_completed
  ) {
    if (
      tiMatch.status !==
      'finished'
    ) {

      if (
        await isTiAdminMode()
      ) {
        return;
      }


      await q(
        `
          UPDATE ti_matches

          SET
            status = 'live',

            betting_closed = 1,

            updated_at =
              CURRENT_TIMESTAMP

          WHERE id = ?
        `,
        [
          tiMatch.id
        ]
      );
    }


    return;
  }


  // ----------------------------------------------
  // Завершён
  // ----------------------------------------------

  if (
    !node.is_completed
  ) {
    return;
  }


  if (
    tiMatch.status ===
    'finished'
  ) {
    return;
  }


  // ----------------------------------------------
  // Получаем ВСЕ match_id серии
  // ----------------------------------------------

  const matchIds =
    getNodeMatchIds(
      node
    );


  if (
    !matchIds.length
  ) {
    console.error(
      `[TI VALVE] completed node=${nodeId} has no match IDs`
    );

    return;
  }


  const games = [];


  // ----------------------------------------------
  // Загружаем каждую карту
  // ----------------------------------------------

  for (
    const matchId
    of matchIds
  ) {

    if (
      await isTiAdminMode()
    ) {
      return;
    }


    try {
      const game =
        await getMatchDetails(
          matchId
        );


      games.push(
        game
      );


      // Успешно полученную карту
      // сохраняем сразу.
      //
      // Если другая карта временно
      // не загрузится, эта информация
      // всё равно останется в БД.

      if (
        await isTiAdminMode()
      ) {
        return;
      }


      await saveGame(
        tiMatch,
        game
      );

    } catch (err) {
      console.error(
        `[TI VALVE] match ${matchId} error:`,
        err.message || err
      );
    }
  }


  // ==================================================
  // ВАЖНАЯ ЗАЩИТА
  //
  // Valve node уже может иметь is_completed=true,
  // но GetMatchDetails одной из карт способен
  // временно не ответить.
  //
  // В таком случае серию НЕ финализируем.
  //
  // На следующем цикле worker попробует снова.
  // ==================================================

  if (
    games.length !==
    matchIds.length
  ) {
    console.error(
      `[TI VALVE] node=${nodeId} incomplete match details ` +
      `${games.length}/${matchIds.length}`
    );

    return;
  }


  // ----------------------------------------------
  // Считаем серию
  // ----------------------------------------------

  const {
    scoreA,
    scoreB
  } =
    calculateSeriesScore(
      tiMatch,
      games
    );


  // ----------------------------------------------
  // Проверяем, что каждая карта
  // действительно дала победителя
  // одной из двух команд серии.
  // ----------------------------------------------

  const accountedGames =
    scoreA + scoreB;


  if (
    accountedGames !==
    games.length
  ) {
    console.error(
      `[TI VALVE] node=${nodeId} invalid game winners ` +
      `counted=${accountedGames}/${games.length}`
    );

    return;
  }


  // ----------------------------------------------
  // Завершённая серия не может
  // иметь равный счёт.
  // ----------------------------------------------

  if (
    scoreA === scoreB
  ) {
    console.error(
      `[TI VALVE] completed node=${nodeId} ` +
      `invalid score ${scoreA}:${scoreB}`
    );

    return;
  }


  // ----------------------------------------------
  // Проверяем формат playoff.
  //
  // node 21 = Grand Final = BO5 = 3 победы.
  //
  // Остальные playoff nodes = BO3 = 2 победы.
  //
  // Для node вне playoff формат не угадываем.
  // ----------------------------------------------

  const requiredWins =
    getRequiredWins(
      nodeId
    );


  if (
    requiredWins !== null
  ) {
    const winnerScore =
      Math.max(
        scoreA,
        scoreB
      );


    if (
      winnerScore <
      requiredWins
    ) {
      console.error(
        `[TI VALVE] node=${nodeId} ` +
        `invalid completed series ` +
        `${scoreA}:${scoreB}; ` +
        `required wins=${requiredWins}`
      );

      return;
    }
  }


  // ----------------------------------------------
  // Победитель серии
  // ----------------------------------------------

  const winnerTeamId =
    scoreA > scoreB
      ? Number(
          tiMatch.team_a_id
        )
      : Number(
          tiMatch.team_b_id
        );


  if (
    !winnerTeamId
  ) {
    console.error(
      `[TI VALVE] node=${nodeId} winner team id is empty`
    );

    return;
  }


  // ----------------------------------------------
  // FINISHED
  // ----------------------------------------------

  if (
    await isTiAdminMode()
  ) {
    return;
  }


  await q(
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
      scoreA,
      scoreB,

      winnerTeamId,

      tiMatch.id
    ]
  );


  console.log(
    `[TI VALVE] FINISHED`,
    `node=${nodeId}`,
    `${tiMatch.team_a_name} ${scoreA}:${scoreB} ${tiMatch.team_b_name}`,
    `winner=${winnerTeamId}`
  );
}


// ==================================================
// Один цикл
// ==================================================

async function syncTiMatches() {

  // ------------------------------------------------
  // ADMIN MODE
  //
  // Пока включён ручной режим, Valve worker
  // не изменяет ti_matches / ti_match_games.
  // ------------------------------------------------

  if (
    await isTiAdminMode()
  ) {
    console.log(
      new Date().toISOString(),
      '[TI ADMIN MODE] match sync skipped'
    );

    return;
  }


  console.log(
    new Date().toISOString(),
    '[TI VALVE] requesting league data'
  );


  const nodes =
    await getTiNodes();


  // Admin Mode мог быть включён,
  // пока выполнялся запрос Valve.

  if (
    await isTiAdminMode()
  ) {
    console.log(
      new Date().toISOString(),
      '[TI ADMIN MODE] match sync cancelled after Valve request'
    );

    return;
  }


  console.log(
    new Date().toISOString(),
    `[TI VALVE] received ${nodes.length} nodes`
  );


  for (
    const node
    of nodes
  ) {
    try {

      if (
        await isTiAdminMode()
      ) {
        console.log(
          new Date().toISOString(),
          '[TI ADMIN MODE] node processing stopped'
        );

        return;
      }


      await syncNode(
        node
      );

    } catch (err) {
      console.error(
        `[TI VALVE] node ${node.node_id} error:`,
        err
      );
    }
  }


  // ------------------------------------------------
  // Перед Live API снова проверяем Admin Mode.
  // ------------------------------------------------

  if (
    await isTiAdminMode()
  ) {
    console.log(
      new Date().toISOString(),
      '[TI ADMIN MODE] live sync skipped'
    );

    return;
  }


  try {
    const liveGames =
      await getTiLiveGames();


    if (
      await isTiAdminMode()
    ) {
      console.log(
        new Date().toISOString(),
        '[TI ADMIN MODE] live sync cancelled after Valve request'
      );

      return;
    }


    console.log(
      new Date().toISOString(),
      `[TI VALVE] ${liveGames.length} live games`
    );


    for (
      const game
      of liveGames
    ) {
      try {

        if (
          await isTiAdminMode()
        ) {
          console.log(
            new Date().toISOString(),
            '[TI ADMIN MODE] live game processing stopped'
          );

          return;
        }


        await syncLiveGame(
          game
        );

      } catch (err) {
        console.error(
          '[TI VALVE] live game error:',
          err
        );
      }
    }

  } catch (err) {
    console.error(
      new Date().toISOString(),
      '[TI VALVE] live API error:',
      err.message || err
    );
  }


  console.log(
    new Date().toISOString(),
    '[TI VALVE] cycle complete'
  );
}


// ==================================================
// Worker
// ==================================================

async function main() {
  console.log(
    new Date().toISOString(),
    'TI Valve match sync worker started'
  );


  while (true) {
    try {
      await syncTiMatches();

    } catch (err) {
      console.error(
        new Date().toISOString(),
        '[TI VALVE] cycle error:',
        err
      );
    }


    await sleep(
      SYNC_INTERVAL_MS
    );
  }
}


// ==================================================
// START
// ==================================================

main().catch(
  err => {
    console.error(
      new Date().toISOString(),
      'TI Valve match sync fatal:',
      err
    );

    process.exit(1);
  }
);