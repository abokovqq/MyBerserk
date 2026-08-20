import fs from 'node:fs/promises';
import path from 'node:path';

import {
  getTiLeagueData
} from '../src/tiDotaApi.js';


const OUTPUT_DIR =
  path.resolve(
    'assets/ti-teams'
  );


// ==============================================
// ПОИСК КОМАНД ВО ВСЁМ ОБЪЕКТЕ VALVE
// ==============================================

function collectTeams(
  value,
  teams = new Map()
) {

  if (
    !value ||
    typeof value !== 'object'
  ) {
    return teams;
  }


  if (!Array.isArray(value)) {

    const teamId =
      Number(value.team_id);


    const teamName =
      String(
        value.team_name || ''
      ).trim();


    const logoUrl =
      String(
        value.team_logo_url || ''
      ).trim();


    if (
      teamId > 0 &&
      teamName &&
      logoUrl
    ) {

      teams.set(
        teamId,
        {
          teamId,
          teamName,
          logoUrl,
          abbreviation:
            String(
              value.team_abbreviation || ''
            ).trim()
        }
      );

    }

  }


  if (Array.isArray(value)) {

    for (const item of value) {
      collectTeams(
        item,
        teams
      );
    }

  } else {

    for (
      const child
      of Object.values(value)
    ) {

      collectTeams(
        child,
        teams
      );

    }

  }


  return teams;
}


// ==============================================
// DOWNLOAD
// ==============================================

async function downloadLogo(
  team
) {

  const file =
    path.join(
      OUTPUT_DIR,
      `${team.teamId}.png`
    );


  const response =
    await fetch(
      team.logoUrl,
      {
        headers: {
          'User-Agent':
            'BERSERK-TI-Bot/2.0'
        }
      }
    );


  if (!response.ok) {

    throw new Error(
      `HTTP ${response.status}`
    );

  }


  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );


  if (!buffer.length) {

    throw new Error(
      'empty response'
    );

  }


  await fs.writeFile(
    file,
    buffer
  );


  return file;
}


// ==============================================
// MAIN
// ==============================================

console.log(
  '[TI LOGOS] requesting Valve league data'
);


await fs.mkdir(
  OUTPUT_DIR,
  {
    recursive: true
  }
);


const data =
  await getTiLeagueData();


const teams =
  collectTeams(data);


console.log(
  `[TI LOGOS] found ${teams.size} teams`
);


let ok = 0;
let failed = 0;


for (
  const team
  of teams.values()
) {

  try {

    const file =
      await downloadLogo(team);


    console.log(
      `[OK] ${team.teamId} ` +
      `${team.teamName} -> ${file}`
    );


    ok++;

  } catch (error) {

    console.error(
      `[FAIL] ${team.teamId} ` +
      `${team.teamName}: ` +
      `${error.message}`
    );


    failed++;

  }

}


console.log('');
console.log(
  `[TI LOGOS] complete ` +
  `ok=${ok} failed=${failed}`
);