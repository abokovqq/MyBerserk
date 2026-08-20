#!/home/a/abokovsa/opt/node/bin/node


import {
  getTiAdminMatches,
  getTiAdminMatch,
  setTiAdminResult,
  resetTiAdminResult,
  resetTiAdminPlayoff
} from '../../tiAdmin.js';


import {
  isTiAdminMode,
  enableTiAdminMode,
  disableTiAdminMode,
  getTiAdminModeFile
} from '../../tiAdminMode.js';


// ==================================================
// HELP
// ==================================================

function showHelp() {

  console.log(`
TI ADMIN

Команды:

  node src/utils/ti/tiAdmin.mjs mode status
  node src/utils/ti/tiAdmin.mjs mode on
  node src/utils/ti/tiAdmin.mjs mode off

  node src/utils/ti/tiAdmin.mjs matches

  node src/utils/ti/tiAdmin.mjs match <node>

  node src/utils/ti/tiAdmin.mjs result <node> <scoreA> <scoreB>

  node src/utils/ti/tiAdmin.mjs reset <node>

  node src/utils/ti/tiAdmin.mjs reset-all


Примеры:

  node src/utils/ti/tiAdmin.mjs mode on

  node src/utils/ti/tiAdmin.mjs result 18 2 1

  node src/utils/ti/tiAdmin.mjs reset 18

  node src/utils/ti/tiAdmin.mjs reset-all

  node src/utils/ti/tiAdmin.mjs mode off
`);

}


// ==================================================
// REQUIRE ADMIN MODE
// ==================================================

async function requireAdminMode() {

  const enabled =
    await isTiAdminMode();


  if (!enabled) {

    throw new Error(
      'TI ADMIN MODE is OFF. Run: mode on'
    );

  }

}


// ==================================================
// FORMAT MATCH
// ==================================================

function printMatch(
  match
) {

  if (!match) {

    console.log(
      'Match not found'
    );

    return;

  }


  const nodeId =
    Number(
      match.source_match_id
    );


  const scoreA =
    match.score_a === null ||
    match.score_a === undefined

      ? '-'

      : match.score_a;


  const scoreB =
    match.score_b === null ||
    match.score_b === undefined

      ? '-'

      : match.score_b;


  console.log(
    `node=${nodeId}` +
    ` | ${match.status}` +
    ` | ${match.team_a_name || '?'}` +
    ` ${scoreA}:${scoreB} ` +
    `${match.team_b_name || '?'}` +
    ` | winner=${match.winner_team_id || '-'}`
  );

}


// ==================================================
// PRINT AFFECTED
// ==================================================

function printAffectedNodes(
  nodes
) {

  if (
    !nodes ||
    !nodes.length
  ) {

    return;

  }


  console.log(
    `AFFECTED NODES: ${nodes.join(', ')}`
  );

}


// ==================================================
// ADMIN MODE
// ==================================================

async function commandMode(
  action = 'status'
) {

  if (
    action === 'status'
  ) {

    const enabled =
      await isTiAdminMode();


    console.log(
      enabled
        ? 'TI ADMIN MODE: ON'
        : 'TI ADMIN MODE: OFF'
    );


    console.log(
      `flag: ${getTiAdminModeFile()}`
    );


    return;

  }


  if (
    action === 'on'
  ) {

    await enableTiAdminMode(
      'console'
    );


    console.log(
      'TI ADMIN MODE: ON'
    );


    console.log(
      `flag: ${getTiAdminModeFile()}`
    );


    return;

  }


  if (
    action === 'off'
  ) {

    await disableTiAdminMode();


    console.log(
      'TI ADMIN MODE: OFF'
    );


    return;

  }


  throw new Error(
    'Usage: mode on|off|status'
  );

}


// ==================================================
// MATCHES
// ==================================================

async function commandMatches() {

  const matches =
    await getTiAdminMatches();


  console.log(
    `TI playoff matches: ${matches.length}`
  );


  console.log(
    '--------------------------------------------------'
  );


  for (
    const match
    of matches
  ) {

    printMatch(
      match
    );

  }

}


// ==================================================
// ONE MATCH
// ==================================================

async function commandMatch(
  nodeId
) {

  const match =
    await getTiAdminMatch(
      nodeId
    );


  printMatch(
    match
  );

}


// ==================================================
// RESULT / CHANGE RESULT
// ==================================================

async function commandResult(
  nodeId,
  scoreA,
  scoreB
) {

  await requireAdminMode();


  const result =
    await setTiAdminResult({
      nodeId,
      scoreA,
      scoreB
    });


  console.log('');


  console.log(
    result.unchanged
      ? 'RESULT UNCHANGED'
      : 'RESULT SAVED'
  );


  console.log(
    '--------------------------------------------------'
  );


  console.log(
    `node=${result.nodeId}`
  );


  console.log(
    `${result.teamAName} ` +
    `${result.scoreA}:${result.scoreB} ` +
    `${result.teamBName}`
  );


  console.log(
    `WINNER: ${result.winnerTeamName} ` +
    `(team_id=${result.winnerTeamId})`
  );


  console.log(
    `LOSER: ${result.loserTeamName} ` +
    `(team_id=${result.loserTeamId})`
  );


  printAffectedNodes(
    result.affectedNodes
  );

}


// ==================================================
// RESET ONE NODE + CASCADE
// ==================================================

async function commandReset(
  nodeId
) {

  await requireAdminMode();


  const result =
    await resetTiAdminResult(
      nodeId
    );


  console.log('');


  console.log(
    'RESULT RESET + CASCADE'
  );


  console.log(
    '--------------------------------------------------'
  );


  console.log(
    `node=${result.nodeId}`
  );


  console.log(
    `${result.teamAName || '?'} vs ` +
    `${result.teamBName || '?'}`
  );


  printAffectedNodes(
    result.affectedNodes
  );

}


// ==================================================
// RESET WHOLE PLAYOFF
// ==================================================

async function commandResetAll() {

  await requireAdminMode();


  const result =
    await resetTiAdminPlayoff();


  console.log('');


  console.log(
    'PLAYOFF RESET COMPLETE'
  );


  console.log(
    '--------------------------------------------------'
  );


  console.log(
    `SOURCE NODES: ${result.sourceNodes.join(', ')}`
  );


  printAffectedNodes(
    result.affectedNodes
  );

}


// ==================================================
// MAIN
// ==================================================

async function main() {

  const [
    ,
    ,
    command,
    ...args
  ] =
    process.argv;


  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {

    showHelp();

    return;

  }


  // ------------------------------------------------
  // mode
  // ------------------------------------------------

  if (
    command === 'mode'
  ) {

    await commandMode(
      args[0] || 'status'
    );

    return;

  }


  // ------------------------------------------------
  // matches
  // ------------------------------------------------

  if (
    command === 'matches'
  ) {

    await commandMatches();

    return;

  }


  // ------------------------------------------------
  // match
  // ------------------------------------------------

  if (
    command === 'match'
  ) {

    if (
      args.length < 1
    ) {

      throw new Error(
        'Usage: match <node>'
      );

    }


    await commandMatch(
      args[0]
    );

    return;

  }


  // ------------------------------------------------
  // result
  // ------------------------------------------------

  if (
    command === 'result'
  ) {

    if (
      args.length < 3
    ) {

      throw new Error(
        'Usage: result <node> <scoreA> <scoreB>'
      );

    }


    await commandResult(
      args[0],
      args[1],
      args[2]
    );

    return;

  }


  // ------------------------------------------------
  // reset
  // ------------------------------------------------

  if (
    command === 'reset'
  ) {

    if (
      args.length < 1
    ) {

      throw new Error(
        'Usage: reset <node>'
      );

    }


    await commandReset(
      args[0]
    );

    return;

  }


  // ------------------------------------------------
  // reset-all
  // ------------------------------------------------

  if (
    command === 'reset-all'
  ) {

    await commandResetAll();

    return;

  }


  throw new Error(
    `Unknown command: ${command}`
  );

}


// ==================================================
// START
// ==================================================

main()

  .then(
    () => {

      process.exit(
        0
      );

    }
  )

  .catch(
    error => {

      console.error(
        '[TI ADMIN] ERROR:',
        error.message || error
      );


      process.exit(
        1
      );

    }
  );