import './env.js';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';


const execFileAsync = promisify(execFile);


export const TI_LEAGUE_ID = 19719;


const LEAGUE_DATA_URL =
  'https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001';


const STEAM_API_BASE =
  'https://api.steampowered.com';


// ==================================================
// CURL JSON
// ==================================================

async function curlJson(url) {

  const { stdout } =
    await execFileAsync(
      'curl',
      [
        '-fsS',
        '--max-time',
        '20',
        url
      ],
      {
        maxBuffer:
          20 * 1024 * 1024
      }
    );


  if (
    !stdout ||
    !stdout.trim()
  ) {
    throw new Error(
      'Valve returned empty response'
    );
  }


  const text =
    stdout.trim();


  if (text === 'null') {
    throw new Error(
      'Valve returned null'
    );
  }


  return JSON.parse(text);
}


// ==================================================
// STEAM KEY
// ==================================================

function getSteamApiKey() {

  const key =
    String(
      process.env.STEAM_API_KEY || ''
    ).trim();


  if (!key) {
    throw new Error(
      'STEAM_API_KEY is not configured'
    );
  }


  return key;
}


// ==================================================
// LEAGUE DATA
//
// Официальные данные турнира Valve.
// ==================================================

export async function getTiLeagueData() {

  const url =
    `${LEAGUE_DATA_URL}` +
    `?league_id=${TI_LEAGUE_ID}` +
    `&delay_seconds=0`;


  const maxAttempts = 3;

  let lastError = null;


  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {

    try {

      return await curlJson(
        url
      );

    } catch (err) {

      lastError = err;


      if (
        attempt >= maxAttempts
      ) {
        break;
      }


      console.warn(
        new Date().toISOString(),
        `[TI VALVE API] GetLeagueData attempt ` +
        `${attempt}/${maxAttempts} failed:`,
        err?.message || err
      );


      // Между попытками:
      // 1-я ошибка -> 1 сек
      // 2-я ошибка -> 2 сек

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            attempt * 1000
          )
      );
    }
  }


  throw lastError;
}


// ==================================================
// СОБИРАЕМ ВСЕ NODE
// ==================================================

export function collectLeagueNodes(
  object,
  result = []
) {

  if (
    !object ||
    typeof object !== 'object'
  ) {
    return result;
  }


  if (
    Object.prototype.hasOwnProperty.call(
      object,
      'node_id'
    )
  ) {
    result.push(object);
  }


  for (
    const value
    of Object.values(object)
  ) {

    if (
      value &&
      typeof value === 'object'
    ) {

      collectLeagueNodes(
        value,
        result
      );

    }

  }


  return result;
}


// ==================================================
// TI NODES
// ==================================================

export async function getTiNodes() {

  const data =
    await getTiLeagueData();


  return collectLeagueNodes(data)
    .filter(
      node =>
        Number(node.node_id) > 0
    );
}


// ==================================================
// LIVE LEAGUE GAMES
//
// Официальный Steam Web API.
// league_node_id связывает live с node_id.
// ==================================================

export async function getTiLiveGames() {

  const key =
    getSteamApiKey();


  const params =
    new URLSearchParams({
      key,
      league_id:
        String(TI_LEAGUE_ID)
    });


  const url =
    `${STEAM_API_BASE}` +
    `/IDOTA2Match_570/` +
    `GetLiveLeagueGames/v1/` +
    `?${params.toString()}`;


  const response =
    await fetch(
      url,
      {
        headers: {
          'Accept':
            'application/json',
          'User-Agent':
            'BERSERK-TI-Bot/2.0'
        }
      }
    );


  if (!response.ok) {

    throw new Error(
      `Valve GetLiveLeagueGames HTTP ` +
      `${response.status}`
    );

  }


  const data =
    await response.json();


  const games =
    data?.result?.games;


  if (!Array.isArray(games)) {
    return [];
  }


  return games.filter(
    game =>
      Number(game.league_id) ===
      TI_LEAGUE_ID
  );
}


// ==================================================
// MATCH DETAILS
//
// Официальный Steam Web API.
// Используем для результата отдельных карт.
// ==================================================

export async function getMatchDetails(
  matchId
) {

  const key =
    getSteamApiKey();


  const params =
    new URLSearchParams({
      key,
      match_id:
        String(matchId)
    });


  const url =
    `${STEAM_API_BASE}` +
    `/IDOTA2Match_570/` +
    `GetMatchDetails/v1/` +
    `?${params.toString()}`;


  const response =
    await fetch(
      url,
      {
        headers: {
          'Accept':
            'application/json',
          'User-Agent':
            'BERSERK-TI-Bot/2.0'
        }
      }
    );


  if (!response.ok) {

    throw new Error(
      `Valve GetMatchDetails ` +
      `match=${matchId} ` +
      `HTTP ${response.status}`
    );

  }


  const data =
    await response.json();


  if (
    !data?.result ||
    !data.result.match_id
  ) {

    throw new Error(
      `Valve invalid match details ` +
      `match=${matchId}`
    );

  }


  return data.result;
}


// ==================================================
// MATCH IDS ИЗ LEAGUE NODE
//
// Valve хранит сыгранные карты внутри node.matches.
// Делаем обход устойчивым к структуре объекта.
// ==================================================

export function getNodeMatchIds(node) {

  const ids =
    new Set();


  function scan(
    value,
    key = ''
  ) {

    if (
      value === null ||
      value === undefined
    ) {
      return;
    }


    if (
      typeof value === 'number'
    ) {

      // Dota match_id сейчас значительно
      // больше 100 млн.
      //
      // Числа внутри массива matches
      // такого размера считаем match_id.

      if (
        key.toLowerCase().includes(
          'match_id'
        ) &&
        value > 100_000_000
      ) {

        ids.add(
          Number(value)
        );

      }

      return;
    }


    if (
      typeof value === 'string'
    ) {

      if (
        key.toLowerCase().includes(
          'match_id'
        )
      ) {

        const id =
          Number(value);


        if (id > 100_000_000) {
          ids.add(id);
        }

      }

      return;
    }


    if (
      typeof value !== 'object'
    ) {
      return;
    }


    if (Array.isArray(value)) {

      for (const item of value) {

        // Иногда API может вернуть
        // просто массив match_id.

        if (
          typeof item === 'number' &&
          item > 100_000_000
        ) {
          ids.add(Number(item));
        } else {
          scan(item);
        }

      }


      return;
    }


    for (
      const [
        childKey,
        childValue
      ]
      of Object.entries(value)
    ) {

      scan(
        childValue,
        childKey
      );

    }

  }


  scan(node?.matches || []);


  return [
    ...ids
  ];
}