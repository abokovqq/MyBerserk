import '../env.js';

import { q } from '../db.js';

import {
  TI_LEAGUE_ID,
  getTiLeagueData,
  collectLeagueNodes
} from '../tiDotaApi.js';

import {
  isTiAdminMode
} from '../tiAdminMode.js';

import {
  getTiRewardForNode
} from '../tiRewards.js';


const SYNC_INTERVAL_MS =
  5 * 60 * 1000;


// ==================================================
// HELPERS
// ==================================================

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


function timestampToMysql(timestamp) {
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
// TEAM MAP
//
// Valve LeagueData содержит team_id / team_name
// в разных местах структуры.
// ==================================================

function buildTeamMap(data) {
  const map =
    new Map();


  function scan(object) {
    if (
      !object ||
      typeof object !== 'object'
    ) {
      return;
    }


    if (
      object.team_id &&
      (
        object.team_name ||
        object.name
      )
    ) {
      const teamId =
        Number(
          object.team_id
        );


      const teamName =
        String(
          object.team_name ||
          object.name
        ).trim();


      if (
        teamId > 0 &&
        teamName
      ) {
        map.set(
          teamId,
          teamName
        );
      }
    }


    for (
      const value
      of Object.values(object)
    ) {
      if (
        value &&
        typeof value === 'object'
      ) {
        scan(value);
      }
    }
  }


  scan(data);


  return map;
}


// ==================================================
// UPSERT MATCH
//
// source_match_id = Valve node_id
//
// Награда:
// reward_group
// points
// bonus_rub
//
// Берётся из ti_reward_config через tiRewards.js.
// ==================================================

async function saveScheduledMatch({
  nodeId,

  teamAId,
  teamAName,

  teamBId,
  teamBName,

  startTime
}) {

  // ------------------------------------------------
  // Получаем актуальную конфигурацию награды
  // для данного Valve node.
  // ------------------------------------------------

  const reward =
    await getTiRewardForNode(
      nodeId
    );


  const rows =
    await q(
      `
        SELECT
          id,
          status,
          betting_closed

        FROM ti_matches

        WHERE
          league_id = ?
          AND source_match_id = ?

        LIMIT 1
      `,
      [
        TI_LEAGUE_ID,
        nodeId
      ]
    );


  const existing =
    rows[0] || null;


  // ------------------------------------------------
  // Завершённый матч не откатываем назад.
  //
  // Его points / bonus_rub являются snapshot
  // награды на момент матча.
  // ------------------------------------------------

  if (
    existing &&
    existing.status === 'finished'
  ) {
    console.log(
      `[TI SCHEDULE] skip finished node=${nodeId}`
    );


    return;
  }


  // ------------------------------------------------
  // ADMIN MODE мог включиться
  // непосредственно во время обработки.
  // ------------------------------------------------

  if (
    await isTiAdminMode()
  ) {
    console.log(
      '[TI ADMIN MODE] schedule write skipped'
    );


    return;
  }


  // ------------------------------------------------
  // UPDATE
  // ------------------------------------------------

  if (existing) {
    await q(
      `
        UPDATE ti_matches

        SET
          team_a_id = ?,
          team_a_name = ?,

          team_b_id = ?,
          team_b_name = ?,

          start_time = ?,

          reward_group = ?,
          points = ?,
          bonus_rub = ?,

          status = 'scheduled',
          betting_closed = 0,

          updated_at =
            CURRENT_TIMESTAMP

        WHERE id = ?
      `,
      [
        teamAId,
        teamAName,

        teamBId,
        teamBName,

        startTime,

        reward.rewardGroup,
        reward.points,
        reward.bonusRub,

        existing.id
      ]
    );


    console.log(
      `[TI SCHEDULE] updated`,
      `node=${nodeId}`,
      `${teamAName} - ${teamBName}`,
      `reward=${reward.points}pt/${reward.bonusRub}rub`,
      startTime
    );


    return;
  }


  // ------------------------------------------------
  // INSERT
  // ------------------------------------------------

  await q(
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

        betting_closed
      )

      VALUES (
        ?,
        ?,

        ?, ?,
        ?, ?,

        ?,

        'scheduled',

        ?,
        ?,
        ?,

        0
      )
    `,
    [
      nodeId,

      TI_LEAGUE_ID,

      teamAId,
      teamAName,

      teamBId,
      teamBName,

      startTime,

      reward.rewardGroup,
      reward.points,
      reward.bonusRub
    ]
  );


  console.log(
    `[TI SCHEDULE] CREATED`,
    `node=${nodeId}`,
    `${teamAName} - ${teamBName}`,
    `reward=${reward.points}pt/${reward.bonusRub}rub`,
    startTime
  );
}


// ==================================================
// CLOSE STALE SCHEDULED MATCHES
//
// Если Valve больше не считает node будущим,
// ставки по нему закрываем.
//
// finished/live обратно не трогаем.
// ==================================================

async function closeStaleScheduledMatches(
  activeNodeIds
) {

  if (
    await isTiAdminMode()
  ) {
    console.log(
      '[TI ADMIN MODE] stale closing skipped'
    );


    return;
  }


  const rows =
    await q(
      `
        SELECT
          id,
          source_match_id,
          team_a_name,
          team_b_name

        FROM ti_matches

        WHERE
          league_id = ?
          AND status = 'scheduled'
          AND betting_closed = 0
      `,
      [
        TI_LEAGUE_ID
      ]
    );


  for (
    const row
    of rows
  ) {

    if (
      await isTiAdminMode()
    ) {
      console.log(
        '[TI ADMIN MODE] stale closing interrupted'
      );


      return;
    }


    const nodeId =
      Number(
        row.source_match_id
      );


    if (
      !activeNodeIds.has(
        nodeId
      )
    ) {
      await q(
        `
          UPDATE ti_matches

          SET
            betting_closed = 1,

            updated_at =
              CURRENT_TIMESTAMP

          WHERE id = ?
        `,
        [
          row.id
        ]
      );


      console.log(
        `[TI SCHEDULE] stale closed`,
        `node=${nodeId}`,
        `${row.team_a_name} - ${row.team_b_name}`
      );
    }
  }
}


// ==================================================
// ONE SYNC
// ==================================================

async function syncSchedule() {

  // ------------------------------------------------
  // ADMIN MODE
  //
  // При ручном тестировании Valve вообще
  // не должен менять playoff DB.
  // ------------------------------------------------

  if (
    await isTiAdminMode()
  ) {
    console.log(
      '[TI ADMIN MODE] schedule sync skipped'
    );


    return;
  }


  console.log(
    new Date().toISOString(),
    '[TI SCHEDULE] requesting Valve'
  );


  const data =
    await getTiLeagueData();


  // ------------------------------------------------
  // Admin mode мог включиться,
  // пока шёл HTTP запрос к Valve.
  // ------------------------------------------------

  if (
    await isTiAdminMode()
  ) {
    console.log(
      '[TI ADMIN MODE] schedule sync skipped after Valve request'
    );


    return;
  }


  const allNodes =
    collectLeagueNodes(
      data
    );


  const teamMap =
    buildTeamMap(
      data
    );


  console.log(
    new Date().toISOString(),

    `[TI SCHEDULE] Valve returned ${allNodes.length} nodes`
  );


  // ------------------------------------------------
  // Только будущие node,
  // где обе команды уже определены.
  // ------------------------------------------------

  const upcomingNodes =
    allNodes.filter(
      node => {

        const nodeId =
          Number(
            node.node_id || 0
          );


        const teamAId =
          Number(
            node.team_id_1 || 0
          );


        const teamBId =
          Number(
            node.team_id_2 || 0
          );


        const scheduledTime =
          Number(
            node.scheduled_time || 0
          );


        return (
          nodeId > 0 &&

          teamAId > 0 &&

          teamBId > 0 &&

          scheduledTime > 0 &&

          !node.has_started &&

          !node.is_completed
        );
      }
    );


  console.log(
    new Date().toISOString(),

    `[TI SCHEDULE] found ${upcomingNodes.length} upcoming Valve nodes`
  );


  const activeNodeIds =
    new Set();


  for (
    const node
    of upcomingNodes
  ) {

    // ------------------------------------------------
    // Не продолжаем писать DB,
    // если админ включил Admin Mode
    // во время цикла.
    // ------------------------------------------------

    if (
      await isTiAdminMode()
    ) {
      console.log(
        '[TI ADMIN MODE] schedule sync interrupted'
      );


      return;
    }


    try {

      const nodeId =
        Number(
          node.node_id
        );


      const teamAId =
        Number(
          node.team_id_1
        );


      const teamBId =
        Number(
          node.team_id_2
        );


      const teamAName =
        teamMap.get(
          teamAId
        ) ||
        `Team ${teamAId}`;


      const teamBName =
        teamMap.get(
          teamBId
        ) ||
        `Team ${teamBId}`;


      const startTime =
        timestampToMysql(
          node.scheduled_time
        );


      activeNodeIds.add(
        nodeId
      );


      await saveScheduledMatch({
        nodeId,

        teamAId,
        teamAName,

        teamBId,
        teamBName,

        startTime
      });


    } catch (err) {

      console.error(
        `[TI SCHEDULE] node ${node.node_id} error:`,
        err
      );

    }
  }


  // ------------------------------------------------
  // Перед stale closing ещё одна проверка.
  // ------------------------------------------------

  if (
    await isTiAdminMode()
  ) {
    console.log(
      '[TI ADMIN MODE] stale closing skipped'
    );


    return;
  }


  // ------------------------------------------------
  // Закрываем устаревшие scheduled записи
  // ------------------------------------------------

  await closeStaleScheduledMatches(
    activeNodeIds
  );


  console.log(
    new Date().toISOString(),
    '[TI SCHEDULE] cycle complete'
  );
}


// ==================================================
// WORKER
// ==================================================

async function main() {

  console.log(
    new Date().toISOString(),
    'TI Valve schedule sync worker started'
  );


  while (true) {

    try {

      await syncSchedule();


    } catch (err) {

      console.error(
        new Date().toISOString(),

        '[TI SCHEDULE] cycle error:',

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

main()
  .catch(
    err => {

      console.error(
        new Date().toISOString(),

        'TI Valve schedule sync fatal:',

        err
      );


      process.exit(
        1
      );

    }
  );