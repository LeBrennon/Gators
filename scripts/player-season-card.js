#!/usr/bin/env node
/*
 * Player Season Card (PITCHER) — a two-page, letter-size, branded PDF of one
 * pitcher's summer. Page 1 is every stat: identity band, profile row,
 * season-totals strip, and the stat panels (run prevention, command & rates,
 * hitters-against, pitch profile, platoon splits). Page 2 is the game-by-game
 * log at full width. Both pages auto-fit — see scripts/lib/season-card-print.js.
 *
 * This is a hand-fed renderer: fill in the DATA block below for the player and
 * run it. Everything else lives in the shared library, so the batter and
 * pitcher cards cannot drift apart. Counting stats come from the official box
 * scores; advanced metrics (BF, K%/BB%, AVG/OBP/SLG/OPS against, BABIP,
 * extra-base hits allowed, FPS%, GB/FB/LD/PU) are computed from TCL
 * play-by-play text. FIP uses the FanGraphs formula
 * ((13*HR + 3*(BB+HBP) - 2*K)/IP + 3.10).
 *
 *   node scripts/player-season-card.js                 # -> reports/players/
 *   node scripts/player-season-card.js /path/stem      # custom output stem
 *
 * Photo: drops in photos/<photoSlug>.<ext> automatically (photoSlug defaults
 * to the player's slug).
 *
 * Requires Chromium (CHROMIUM_PATH, /opt/pw-browsers, a Playwright install,
 * or Mac Chrome). No other dependencies.
 */
const { render } = require('./lib/season-card-print');

const stemArg = process.argv.slice(2).find(a => a && !a.startsWith('--'));

// ===========================================================================
// PLAYER DATA — replace this block for each player. Everything below is generic.
// ===========================================================================
const DATA = {
  "name": "Brayden Guillory",
  "num": "47",
  "pos": "RHP",
  "bt": "R/R",
  "cls": "R-Freshman",
  "school": "Southern University",
  "home": "Kinder, LA",
  "htwt": "6-2 · 200",
  "bday": "11/17/2005",
  "photoSlug": "braydenguillory",
  "seasonTitle": "Season Totals — Pitching",
  "season": [
    [
      "APP",
      "7"
    ],
    [
      "GS",
      "0"
    ],
    [
      "IP",
      "11.0"
    ],
    [
      "BF",
      "60"
    ],
    [
      "ERA",
      "14.73"
    ],
    [
      "WHIP",
      "2.27"
    ],
    [
      "FIP",
      "8.83"
    ],
    [
      "K",
      "3"
    ],
    [
      "BB",
      "9"
    ],
    [
      "H",
      "16"
    ]
  ],
  "groups": [
    [
      "RUN PREVENTION",
      [
        [
          "ERA",
          "14.73"
        ],
        [
          "WHIP",
          "2.27"
        ],
        [
          "FIP",
          "8.83"
        ],
        [
          "HR",
          "3"
        ],
        [
          "HR/9",
          "2.5"
        ],
        [
          "H",
          "16"
        ],
        [
          "R",
          "19"
        ],
        [
          "ER",
          "18"
        ]
      ]
    ],
    [
      "COMMAND & RATES",
      [
        [
          "K%",
          "5.0"
        ],
        [
          "BB%",
          "15.0"
        ],
        [
          "K−BB%",
          "−10.0"
        ],
        [
          "K/9",
          "2.5"
        ],
        [
          "BB/9",
          "7.4"
        ],
        [
          "H/9",
          "13.1"
        ],
        [
          "K:BB",
          "0.33"
        ],
        [
          "P/BF",
          "3.5"
        ]
      ]
    ],
    [
      "HITTERS VS. GUILLORY",
      [
        [
          "AVG",
          ".333"
        ],
        [
          "OBP",
          ".441"
        ],
        [
          "SLG",
          ".562"
        ],
        [
          "OPS",
          "1.003"
        ],
        [
          "ISO",
          ".229"
        ],
        [
          "BABIP",
          ".302"
        ],
        [
          "2B",
          "2"
        ],
        [
          "3B",
          "0"
        ],
        [
          "vs LHB (21 PA)",
          ".222/.333/.444",
          "wide",
          "AVG · OBP · SLG"
        ],
        [
          "vs RHB (39 PA)",
          ".400/.500/.633",
          "wide",
          "AVG · OBP · SLG"
        ]
      ]
    ],
    [
      "PITCH PROFILE",
      [
        [
          "#P",
          "212"
        ],
        [
          "S%",
          "52"
        ],
        [
          "FPS%",
          "60.0"
        ],
        [
          "P/IP",
          "19.3"
        ],
        [
          "GB%",
          "40"
        ],
        [
          "FB%",
          "36"
        ],
        [
          "LD% / PU%",
          "4 / 20"
        ]
      ]
    ]
  ],
  "key": [
    [
      "BF",
      "batters faced"
    ],
    [
      "K% / BB%",
      "strikeouts / walks per BF"
    ],
    [
      "K/9 · BB/9 · H/9 · HR/9",
      "per 9 innings"
    ],
    [
      "FIP",
      "fielding independent pitching"
    ],
    [
      "AVG / OBP / SLG / OPS",
      "hitters' slash line against"
    ],
    [
      "vs LHB / vs RHB",
      "AVG/OBP/SLG by batter side (switch bats left vs RHP)"
    ],
    [
      "ISO",
      "isolated power (SLG − AVG)"
    ],
    [
      "BABIP",
      "batting avg on balls in play"
    ],
    [
      "#P",
      "total pitches"
    ],
    [
      "S%",
      "strike percentage"
    ],
    [
      "FPS%",
      "first-pitch strikes"
    ],
    [
      "P/IP · P/BF",
      "pitches per inning / batter"
    ],
    [
      "GB / FB / LD / PU",
      "ground ball / fly ball / line drive / popup % (outs)"
    ]
  ],
  "logTitle": "Game by Game",
  "logCols": [
    "Date",
    "Opponent",
    "Result",
    "IP",
    "BF",
    "H",
    "R",
    "ER",
    "BB",
    "K",
    "#P",
    "S%",
    "ERA"
  ],
  "log": [
    [
      "Jul 1",
      "at Brazos Valley",
      "W, 10-8",
      "3.1",
      "12",
      "1",
      "2",
      "2",
      "1",
      "3",
      "41",
      "41",
      "5.40"
    ],
    [
      "Jul 7",
      "at Acadiana",
      "L, 4-7",
      "0.2",
      "3",
      "1",
      "0",
      "0",
      "1",
      "0",
      "14",
      "43",
      "0.00"
    ],
    [
      "Jul 12",
      "at San Antonio",
      "L, 4-8",
      "3.1",
      "17",
      "5",
      "5",
      "5",
      "1",
      "0",
      "56",
      "63",
      "13.50"
    ],
    [
      "Jul 15",
      "at Baton Rouge",
      "L, 2-9",
      "1.2",
      "11",
      "3",
      "5",
      "4",
      "1",
      "0",
      "41",
      "54",
      "21.60"
    ],
    [
      "Jul 19",
      "Brazos Valley",
      "W, 14-11",
      "0.2",
      "7",
      "3",
      "5",
      "5",
      "2",
      "0",
      "23",
      "57",
      "67.50"
    ],
    [
      "Jul 23",
      "Sherman",
      "W, 8-7",
      "1.0",
      "6",
      "2",
      "2",
      "2",
      "1",
      "0",
      "21",
      "52",
      "18.00"
    ],
    [
      "Jul 26",
      "Abilene",
      "W, 5-4",
      "0.1",
      "4",
      "1",
      "0",
      "0",
      "2",
      "0",
      "16",
      "44",
      "0.00"
    ]
  ],
  "totals": [
    "TOTAL",
    "7 G",
    "",
    "11.0",
    "60",
    "16",
    "19",
    "18",
    "9",
    "3",
    "212",
    "52",
    "14.73"
  ]
};
// ===========================================================================

render(DATA, stemArg);
