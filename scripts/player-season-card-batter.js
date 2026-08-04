#!/usr/bin/env node
/*
 * Player Season Card (BATTER) — a two-page, letter-size, branded PDF of one
 * hitter's summer. Page 1 is every stat: identity band, profile row,
 * season-totals strip, and the stat panels (production incl. wOBA/wRC+, plate
 * discipline and count splits, hit breakdown and batted-ball direction, base
 * running and defense, platoon splits). Page 2 is the game-by-game log at full
 * width. Both pages auto-fit — see scripts/lib/season-card-print.js.
 *
 * This is a hand-fed renderer: fill in the DATA block below for the player and
 * run it. Everything else lives in the shared library, so the batter and
 * pitcher cards cannot drift apart. Counting stats come from the official box
 * scores; advanced metrics (splits, spray, count buckets, wOBA/wRC+, fielding)
 * are computed from TCL play-by-play text — see docs/agents/player-cards.md.
 *
 *   node scripts/player-season-card-batter.js             # -> reports/players/
 *   node scripts/player-season-card-batter.js /path/stem  # custom output stem
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
  "name": "Ayden Sunday",
  "num": "17",
  "pos": "OF",
  "bt": "R/R",
  "cls": "Freshman",
  "school": "Lamar University",
  "home": "Nederland, TX",
  "htwt": "6-0 \u00b7 185",
  "bday": "\u2014",
  "photoSlug": "aydensundayyp1j",
  "seasonTitle": "Season Totals \u2014 Hitting",
  "season": [
    [
      "G",
      "41"
    ],
    [
      "PA",
      "185"
    ],
    [
      "AVG",
      ".286"
    ],
    [
      "OBP",
      ".438"
    ],
    [
      "SLG",
      ".471"
    ],
    [
      "OPS",
      ".909"
    ],
    [
      "HR",
      "3"
    ],
    [
      "RBI",
      "36"
    ],
    [
      "SB",
      "14"
    ]
  ],
  "groups": [
    [
      "PRODUCTION",
      [
        [
          "AVG",
          ".286"
        ],
        [
          "OBP",
          ".438"
        ],
        [
          "SLG",
          ".471"
        ],
        [
          "OPS",
          ".909"
        ],
        [
          "ISO",
          ".186"
        ],
        [
          "BABIP",
          ".339"
        ],
        [
          "XBH",
          "16"
        ],
        [
          "TB",
          "66"
        ],
        [
          "vs LHP (52 PA)",
          ".289/.385/.333",
          "wide",
          "AVG \u00b7 OBP \u00b7 SLG \u2014 OPS .718"
        ],
        [
          "vs RHP (133 PA)",
          ".284/.459/.537",
          "wide",
          "AVG \u00b7 OBP \u00b7 SLG \u2014 OPS .995"
        ]
      ]
    ],
    [
      "PLATE DISCIPLINE",
      [
        [
          "BB%",
          "15.1"
        ],
        [
          "K%",
          "17.3"
        ],
        [
          "BB:K",
          "0.88"
        ],
        [
          "PA",
          "185"
        ],
        [
          "BB",
          "28"
        ],
        [
          "K",
          "32"
        ],
        [
          "HBP",
          "13"
        ],
        [
          "SF",
          "4"
        ]
      ]
    ],
    [
      "HIT BREAKDOWN",
      [
        [
          "H",
          "40"
        ],
        [
          "1B",
          "24"
        ],
        [
          "2B",
          "9"
        ],
        [
          "3B",
          "4"
        ],
        [
          "HR",
          "3"
        ],
        [
          "RBI",
          "36"
        ],
        [
          "R",
          "35"
        ],
        [
          "GIDP",
          "1"
        ]
      ]
    ],
    [
      "BASE RUNNING & TCL RANKS",
      [
        [
          "SB",
          "14"
        ],
        [
          "CS",
          "3"
        ],
        [
          "SB%",
          "82.4"
        ],
        [
          "SB-ATT",
          "14-17"
        ],
        [
          "League ranks",
          "RBI 2nd \u00b7 3B 2nd \u00b7 R 3rd",
          "wide",
          "TCL BATTERS"
        ],
        [
          "Also",
          "PA 3rd \u00b7 TB 5th \u00b7 H 5th",
          "wide",
          "TCL BATTERS"
        ]
      ]
    ]
  ],
  "key": [
    [
      "OBP",
      "on-base pct (H+BB+HBP per PA)"
    ],
    [
      "SLG",
      "total bases per AB"
    ],
    [
      "OPS",
      "OBP + SLG"
    ],
    [
      "ISO",
      "isolated power (SLG \u2212 AVG)"
    ],
    [
      "BABIP",
      "batting avg on balls in play"
    ],
    [
      "BB% / K%",
      "walks / strikeouts per PA"
    ],
    [
      "XBH \u00b7 TB",
      "extra-base hits \u00b7 total bases"
    ],
    [
      "SB%",
      "stolen-base success (SB \u00f7 attempts)"
    ],
    [
      "SF",
      "sacrifice flies (not an AB)"
    ]
  ],
  "logTitle": "Game by Game \u2014 Hitting",
  "logCols": [
    "Date",
    "Opponent",
    "Result",
    "PA",
    "AB",
    "R",
    "H",
    "RBI",
    "BB",
    "K",
    "SB",
    "AVG"
  ],
  "log": [
    [
      "Jun 2",
      "Abilene",
      "W, 11-1",
      "1",
      "1",
      "0",
      "1",
      "0",
      "0",
      "0",
      "1",
      "1.000"
    ],
    [
      "Jun 4",
      "Baton Rouge",
      "L, 18-5",
      "4",
      "4",
      "0",
      "1",
      "1",
      "0",
      "1",
      "1",
      ".250"
    ],
    [
      "Jun 5",
      "at Baton Rouge",
      "W, 14-1",
      "7",
      "4",
      "2",
      "2",
      "1",
      "2",
      "0",
      "1",
      ".500"
    ],
    [
      "Jun 6",
      "at Baton Rouge",
      "L, 9-8",
      "6",
      "2",
      "2",
      "0",
      "1",
      "1",
      "2",
      "0",
      ".000"
    ],
    [
      "Jun 7",
      "at Baton Rouge",
      "L, 5-4",
      "5",
      "4",
      "2",
      "1",
      "0",
      "1",
      "1",
      "0",
      ".250"
    ],
    [
      "Jun 9",
      "Baton Rouge",
      "W, 3-1",
      "4",
      "4",
      "0",
      "2",
      "1",
      "0",
      "0",
      "0",
      ".500"
    ],
    [
      "Jun 10",
      "Baton Rouge",
      "W, 8-7",
      "5",
      "3",
      "0",
      "0",
      "1",
      "1",
      "2",
      "1",
      ".000"
    ],
    [
      "Jun 11",
      "at Acadiana",
      "L, 4-3",
      "1",
      "1",
      "0",
      "0",
      "0",
      "0",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 12",
      "Acadiana",
      "W, 16-15",
      "5",
      "3",
      "3",
      "1",
      "2",
      "1",
      "2",
      "0",
      ".333"
    ],
    [
      "Jun 13",
      "at Victoria",
      "L, 7-6",
      "6",
      "5",
      "1",
      "2",
      "4",
      "0",
      "0",
      "0",
      ".400"
    ],
    [
      "Jun 14",
      "at Victoria",
      "L, 10-3",
      "5",
      "3",
      "0",
      "0",
      "0",
      "2",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 16",
      "Acadiana",
      "L, 9-5",
      "5",
      "3",
      "1",
      "0",
      "0",
      "2",
      "2",
      "1",
      ".000"
    ],
    [
      "Jun 17",
      "Acadiana",
      "L, 11-7",
      "5",
      "5",
      "1",
      "0",
      "0",
      "0",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 18",
      "at Acadiana",
      "L, 4-2",
      "1",
      "1",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      ".000"
    ],
    [
      "Jun 19",
      "at Acadiana",
      "W, 6-3",
      "5",
      "4",
      "1",
      "0",
      "0",
      "1",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 20",
      "at Sherman",
      "W, 8-1",
      "5",
      "4",
      "1",
      "2",
      "2",
      "1",
      "1",
      "2",
      ".500"
    ],
    [
      "Jun 21",
      "at Sherman",
      "W, 12-11",
      "6",
      "3",
      "0",
      "0",
      "0",
      "2",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 23",
      "Victoria",
      "W, 6-5",
      "5",
      "4",
      "1",
      "1",
      "2",
      "1",
      "1",
      "0",
      ".250"
    ],
    [
      "Jun 24",
      "Victoria",
      "L, 7-3",
      "4",
      "4",
      "1",
      "2",
      "1",
      "0",
      "0",
      "0",
      ".500"
    ],
    [
      "Jun 25",
      "at Brazos Valley",
      "W, 7-0",
      "2",
      "1",
      "0",
      "0",
      "0",
      "1",
      "0",
      "1",
      ".000"
    ],
    [
      "Jun 26",
      "at Brazos Valley",
      "L, 10-8",
      "5",
      "4",
      "1",
      "3",
      "2",
      "0",
      "0",
      "0",
      ".750"
    ],
    [
      "Jun 27",
      "Baton Rouge",
      "W, 7-6",
      "5",
      "3",
      "0",
      "0",
      "1",
      "0",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 28",
      "at Baton Rouge",
      "W, 8-5",
      "4",
      "3",
      "1",
      "0",
      "0",
      "0",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 30",
      "at Brazos Valley",
      "L, 9-3",
      "4",
      "3",
      "0",
      "1",
      "0",
      "1",
      "1",
      "0",
      ".333"
    ],
    [
      "Jul 1",
      "at Brazos Valley",
      "W, 10-8",
      "5",
      "5",
      "1",
      "3",
      "2",
      "0",
      "0",
      "1",
      ".600"
    ],
    [
      "Jul 2",
      "San Antonio",
      "W, 16-0",
      "6",
      "6",
      "2",
      "2",
      "0",
      "0",
      "0",
      "0",
      ".333"
    ],
    [
      "Jul 3",
      "San Antonio",
      "W, 9-7",
      "4",
      "3",
      "1",
      "2",
      "6",
      "0",
      "0",
      "0",
      ".667"
    ],
    [
      "Jul 4",
      "Brazos Valley",
      "W, 7-3",
      "5",
      "5",
      "1",
      "2",
      "1",
      "0",
      "1",
      "1",
      ".400"
    ],
    [
      "Jul 7",
      "at Acadiana",
      "L, 7-4",
      "5",
      "4",
      "0",
      "2",
      "1",
      "1",
      "0",
      "1",
      ".500"
    ],
    [
      "Jul 8",
      "Acadiana",
      "W, 15-6",
      "5",
      "2",
      "0",
      "0",
      "0",
      "3",
      "1",
      "0",
      ".000"
    ],
    [
      "Jul 9",
      "at Abilene",
      "L, 5-4",
      "4",
      "4",
      "0",
      "0",
      "0",
      "0",
      "3",
      "0",
      ".000"
    ],
    [
      "Jul 10",
      "at Abilene",
      "L, 4-3",
      "4",
      "4",
      "1",
      "1",
      "0",
      "0",
      "1",
      "0",
      ".250"
    ],
    [
      "Jul 12 G1",
      "at San Antonio",
      "W, 3-2",
      "4",
      "3",
      "0",
      "1",
      "0",
      "1",
      "0",
      "0",
      ".333"
    ],
    [
      "Jul 12 G2",
      "at San Antonio",
      "L, 8-4",
      "4",
      "4",
      "1",
      "1",
      "0",
      "0",
      "1",
      "0",
      ".250"
    ],
    [
      "Jul 14",
      "Baton Rouge",
      "W, 5-4",
      "5",
      "3",
      "0",
      "0",
      "1",
      "1",
      "1",
      "0",
      ".000"
    ],
    [
      "Jul 15",
      "at Baton Rouge",
      "L, 9-2",
      "4",
      "4",
      "0",
      "1",
      "1",
      "0",
      "0",
      "0",
      ".250"
    ],
    [
      "Jul 16",
      "Baton Rouge",
      "W, 10-2",
      "5",
      "3",
      "1",
      "1",
      "2",
      "1",
      "0",
      "1",
      ".333"
    ],
    [
      "Jul 18",
      "Brazos Valley",
      "W, 11-8",
      "5",
      "3",
      "4",
      "3",
      "1",
      "2",
      "0",
      "1",
      "1.000"
    ],
    [
      "Jul 19",
      "Brazos Valley",
      "W, 14-11",
      "6",
      "3",
      "2",
      "0",
      "1",
      "1",
      "1",
      "0",
      ".000"
    ],
    [
      "Jul 21",
      "at Victoria",
      "W, 12-7",
      "5",
      "4",
      "3",
      "2",
      "1",
      "1",
      "1",
      "1",
      ".500"
    ],
    [
      "Jul 22",
      "at Victoria",
      "L, 6-0",
      "4",
      "4",
      "0",
      "0",
      "0",
      "0",
      "2",
      "0",
      ".000"
    ]
  ],
  "totals": [
    "TOTAL",
    "41 G",
    "",
    "185",
    "140",
    "35",
    "40",
    "36",
    "28",
    "32",
    "14",
    ".286"
  ]
};
// ===========================================================================

render(DATA, stemArg);
