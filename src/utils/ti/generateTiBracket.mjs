import '../../env.js';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { q } from '../../db.js';


// ============================================================
// PATHS
// ============================================================

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);


// src/utils/ti -> project root
const PROJECT_DIR =
  path.resolve(
    __dirname,
    '../../..'
  );


const BACKGROUND =
  path.join(
    PROJECT_DIR,
    'assets/ti-bracket/ti2026_bracket.png'
  );


const LOGO_DIR =
  path.join(
    PROJECT_DIR,
    'assets/ti-teams'
  );


const OUTPUT_DIR =
  path.join(
    PROJECT_DIR,
    'tmp'
  );


const OUTPUT_FILE =
  path.join(
    OUTPUT_DIR,
    'ti-bracket.png'
  );


// ============================================================
// CONSTANTS
// ============================================================

const TI_LEAGUE_ID = 19719;


// Размер зафиксированного изображения.

const WIDTH = 1535;
const HEIGHT = 1024;


// Размер уже нарисованных на фоне ячеек.
// Сами ячейки здесь НЕ рисуем.

const BOX_W = 184;
const BOX_H = 62;
const ROW_H = 31;


// Размер командного логотипа.

const LOGO_W = 24;
const LOGO_H = 24;


// ============================================================
// FIXED BRACKET GEOMETRY
//
// Эти координаты соответствуют ЗАФИКСИРОВАННОМУ
// assets/ti-bracket/ti2026_bracket.png
//
// Менять их без изменения фона нельзя.
// ============================================================

const X1 = 52;
const X2 = 360;
const X3 = 680;
const X4 = 950;
const X5 = 1230;


// ------------------------------------------------------------
// UPPER BRACKET
// ------------------------------------------------------------

const UQF = [
  356,
  432,
  508,
  584
];


const USF = [
  394,
  546
];


const UF = 470;


const GF = 486;


// ------------------------------------------------------------
// LOWER BRACKET
// ------------------------------------------------------------

const LR1 = [
  803,
  895
];


const LR2 = [
  787,
  879
];


const LR3 = 837;


const LF = 821;


// ============================================================
// VALVE NODE -> BRACKET CELL
//
// Valve playoff structure:
//
// 14-17  Upper Quarterfinals
// 18-19  Upper Semifinals
// 20     Upper Final
// 21     Grand Final
//
// 22-23  Lower Round 1
// 25,24  Lower Round 2
// 26     Lower Round 3
// 27     Lower Final
// ============================================================

const NODE_BOXES =
  new Map([

    // ========================================================
    // UPPER QUARTERFINALS
    // ========================================================

    [
      14,
      {
        x: X1,
        y: UQF[0]
      }
    ],

    [
      15,
      {
        x: X1,
        y: UQF[1]
      }
    ],

    [
      16,
      {
        x: X1,
        y: UQF[2]
      }
    ],

    [
      17,
      {
        x: X1,
        y: UQF[3]
      }
    ],


    // ========================================================
    // UPPER SEMIFINALS
    // ========================================================

    [
      18,
      {
        x: X2,
        y: USF[0]
      }
    ],

    [
      19,
      {
        x: X2,
        y: USF[1]
      }
    ],


    // ========================================================
    // UPPER FINAL
    // ========================================================

    [
      20,
      {
        x: X4,
        y: UF
      }
    ],


    // ========================================================
    // GRAND FINAL
    // ========================================================

    [
      21,
      {
        x: X5,
        y: GF
      }
    ],


    // ========================================================
    // LOWER ROUND 1
    // ========================================================

    [
      22,
      {
        x: X1,
        y: LR1[0]
      }
    ],

    [
      23,
      {
        x: X1,
        y: LR1[1]
      }
    ],


    // ========================================================
    // LOWER ROUND 2
    //
    // node 24 — верхняя ячейка
    // node 25 — нижняя ячейка
    //
    // ВАЖНО:
    // время матчей при этом:
    // node 25 = 22.08 10:00
    // node 24 = 22.08 13:00
    // ========================================================

    [
      24,
      {
        x: X2,
        y: LR2[0]
      }
    ],

    [
      25,
      {
        x: X2,
        y: LR2[1]
      }
    ],


    // ========================================================
    // LOWER ROUND 3
    // ========================================================

    [
      26,
      {
        x: X3,
        y: LR3
      }
    ],


    // ========================================================
    // LOWER FINAL
    // ========================================================

    [
      27,
      {
        x: X4,
        y: LF
      }
    ]

  ]);


// ============================================================
// XML ESCAPE
// ============================================================

function escapeXml(value) {

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
    )
    .replaceAll(
      '"',
      '&quot;'
    )
    .replaceAll(
      "'",
      '&apos;'
    );

}


// ============================================================
// TEAM NAME FONT SIZE
//
// Если название длинное — немного уменьшаем шрифт,
// чтобы оно не залезало на счёт.
// ============================================================

function getTeamFontSize(name) {

  const length =
    String(
      name ?? ''
    ).length;


  if (length <= 12) {
    return 13;
  }


  if (length <= 16) {
    return 12;
  }


  if (length <= 20) {
    return 11;
  }


  return 10;

}


// ============================================================
// MATCH CONTENT SVG
//
// ВАЖНО:
// здесь НЕ рисуем:
// - rect
// - border
// - divider
// - bracket lines
//
// Только текст команд и счёт.
// ============================================================

function createMatchContentSvg(
  x,
  y,
  match
) {

  const rawTeamA =
    match?.team_a_name || '';


  const rawTeamB =
    match?.team_b_name || '';


  const teamA =
    escapeXml(
      rawTeamA
    );


  const teamB =
    escapeXml(
      rawTeamB
    );


  const fontA =
    getTeamFontSize(
      rawTeamA
    );


  const fontB =
    getTeamFontSize(
      rawTeamB
    );


  const scoreA =
    match?.score_a === null ||
    match?.score_a === undefined

      ? ''

      : escapeXml(
          match.score_a
        );


  const scoreB =
    match?.score_b === null ||
    match?.score_b === undefined

      ? ''

      : escapeXml(
          match.score_b
        );


  // ----------------------------------------------------------
  // Координаты
  //
  // logo:
  // x + 5 ... x + 29
  //
  // team:
  // начинается с x + 34
  //
  // score:
  // справа x + BOX_W - 9
  // ----------------------------------------------------------

  const teamTextX =
    x + 34;


  const scoreX =
    x + BOX_W - 9;


  const teamAY =
    y + 21;


  const teamBY =
    y + ROW_H + 21;


  return `
    <g>

      <!-- TEAM A -->

      <text
        x="${teamTextX}"
        y="${teamAY}"

        font-family="DejaVu Sans, Arial, sans-serif"
        font-size="${fontA}"
        font-weight="700"

        fill="#F4EFE2"
      >${teamA}</text>


      <!-- TEAM B -->

      <text
        x="${teamTextX}"
        y="${teamBY}"

        font-family="DejaVu Sans, Arial, sans-serif"
        font-size="${fontB}"
        font-weight="700"

        fill="#F4EFE2"
      >${teamB}</text>


      <!-- SCORE A -->

      <text
        x="${scoreX}"
        y="${teamAY}"

        text-anchor="end"

        font-family="DejaVu Sans, Arial, sans-serif"
        font-size="14"
        font-weight="700"

        fill="#DDAA37"
      >${scoreA}</text>


      <!-- SCORE B -->

      <text
        x="${scoreX}"
        y="${teamBY}"

        text-anchor="end"

        font-family="DejaVu Sans, Arial, sans-serif"
        font-size="14"
        font-weight="700"

        fill="#DDAA37"
      >${scoreB}</text>

    </g>
  `;

}


// ============================================================
// CREATE SVG CONTENT LAYER
// ============================================================

function createContentSvg(
  matches
) {

  let content =
    '';


  for (
    const match
    of matches
  ) {

    const nodeId =
      Number(
        match.source_match_id
      );


    const position =
      NODE_BOXES.get(
        nodeId
      );


    if (!position) {

      console.log(
        `[TI BRACKET] node ${nodeId}: no bracket position`
      );

      continue;

    }


    content +=
      createMatchContentSvg(

        position.x,

        position.y,

        match

      );

  }


  return Buffer.from(`
    <svg
      width="${WIDTH}"
      height="${HEIGHT}"

      viewBox="0 0 ${WIDTH} ${HEIGHT}"

      xmlns="http://www.w3.org/2000/svg"
    >

      ${content}

    </svg>
  `);

}


// ============================================================
// CREATE TEAM LOGO
// ============================================================

async function createLogoComposite(
  teamId,
  x,
  y
) {

  const id =
    Number(
      teamId
    );


  if (!id) {
    return null;
  }


  const logoPath =
    path.join(
      LOGO_DIR,
      `${id}.png`
    );


  try {

    await fs.access(
      logoPath
    );

  } catch {

    console.warn(
      `[TI BRACKET] logo missing: team_id=${id}`
    );

    return null;

  }


  try {

    const buffer =
      await sharp(
        logoPath
      )

        .resize(
          LOGO_W,
          LOGO_H,
          {
            fit:
              'contain',

            background:
              {
                r: 0,
                g: 0,
                b: 0,
                alpha: 0
              }
          }
        )

        .png()

        .toBuffer();


    return {

      input:
        buffer,

      left:
        Math.round(
          x
        ),

      top:
        Math.round(
          y
        )

    };


  } catch (error) {

    console.warn(
      `[TI BRACKET] failed to render logo team_id=${id}:`,
      error.message
    );


    return null;

  }

}


// ============================================================
// CHECK BACKGROUND
// ============================================================

async function checkBackground() {

  await fs.access(
    BACKGROUND
  );


  const metadata =
    await sharp(
      BACKGROUND
    ).metadata();


  console.log(
    `[TI BRACKET] background: ${BACKGROUND}`
  );


  console.log(
    `[TI BRACKET] background size: ${metadata.width}x${metadata.height}`
  );


  if (
    metadata.width !== WIDTH ||
    metadata.height !== HEIGHT
  ) {

    throw new Error(
      `Unexpected background size: ` +
      `${metadata.width}x${metadata.height}; ` +
      `expected ${WIDTH}x${HEIGHT}`
    );

  }

}


// ============================================================
// LOAD MATCHES
// ============================================================

async function loadMatches() {

  const matches =
    await q(
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

          score_a,
          score_b,

          winner_team_id,

          betting_closed

        FROM ti_matches

        WHERE league_id = ?

        ORDER BY
          source_match_id ASC,
          id ASC
      `,
      [
        TI_LEAGUE_ID
      ]
    );


  return matches;

}


// ============================================================
// MAIN
// ============================================================

async function main() {

  // ----------------------------------------------------------
  // PATH INFO
  // ----------------------------------------------------------

  console.log(
    `[TI BRACKET] PROJECT_DIR: ${PROJECT_DIR}`
  );


  console.log(
    `[TI BRACKET] OUTPUT: ${OUTPUT_FILE}`
  );


  // ----------------------------------------------------------
  // OUTPUT DIR
  // ----------------------------------------------------------

  await fs.mkdir(
    OUTPUT_DIR,
    {
      recursive: true
    }
  );


  // ----------------------------------------------------------
  // BACKGROUND
  // ----------------------------------------------------------

  await checkBackground();


  // ----------------------------------------------------------
  // MATCHES
  // ----------------------------------------------------------

  const matches =
    await loadMatches();


  console.log(
    `[TI BRACKET] DB matches: ${matches.length}`
  );


  // ----------------------------------------------------------
  // CONTENT SVG
  // ----------------------------------------------------------

  const contentSvg =
    createContentSvg(
      matches
    );


  const composites =
    [

      {
        input:
          contentSvg,

        left:
          0,

        top:
          0
      }

    ];


  // ----------------------------------------------------------
  // TEAM LOGOS
  // ----------------------------------------------------------

  for (
    const match
    of matches
  ) {

    const nodeId =
      Number(
        match.source_match_id
      );


    const position =
      NODE_BOXES.get(
        nodeId
      );


    if (!position) {
      continue;
    }


    // ========================================================
    // TEAM A LOGO
    // ========================================================

    const logoA =
      await createLogoComposite(

        match.team_a_id,

        position.x + 5,

        position.y + 3

      );


    if (logoA) {

      composites.push(
        logoA
      );

    }


    // ========================================================
    // TEAM B LOGO
    // ========================================================

    const logoB =
      await createLogoComposite(

        match.team_b_id,

        position.x + 5,

        position.y + ROW_H + 3

      );


    if (logoB) {

      composites.push(
        logoB
      );

    }

  }


  // ----------------------------------------------------------
  // FINAL IMAGE
  //
  // ВАЖНО:
  // background НЕ resize.
  // Никакая сетка не рисуется.
  // ----------------------------------------------------------

  await sharp(
    BACKGROUND
  )

    .composite(
      composites
    )

    .png()

    .toFile(
      OUTPUT_FILE
    );


  console.log(
    `[TI BRACKET] generated: ${OUTPUT_FILE}`
  );


  // ----------------------------------------------------------
  // DEBUG NODE MAP
  // ----------------------------------------------------------

  for (
    const match
    of matches
  ) {

    const nodeId =
      Number(
        match.source_match_id
      );


    const position =
      NODE_BOXES.get(
        nodeId
      );


    if (!position) {
      continue;
    }


    console.log(
      `[TI BRACKET] node=${nodeId}` +
      ` x=${position.x}` +
      ` y=${position.y}` +
      ` ${match.team_a_name || '?'} vs ${match.team_b_name || '?'}`
    );

  }

}


// ============================================================
// START
// ============================================================

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
        '[TI BRACKET] ERROR:',
        error
      );


      process.exit(
        1
      );

    }
  );