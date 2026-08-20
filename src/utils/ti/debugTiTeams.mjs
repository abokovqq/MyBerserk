import {
  getTiLeagueData,
  collectLeagueNodes
} from '../src/tiDotaApi.js';

const data = await getTiLeagueData();

console.log('===== TOP LEVEL KEYS =====');
console.log(Object.keys(data));

console.log('\n===== POSSIBLE TEAM DATA =====');

function scan(value, path = 'root') {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (!Array.isArray(value)) {
    const keys = Object.keys(value);

    const interesting =
      keys.some(k =>
        /team|logo|name/i.test(k)
      );

    if (interesting) {
      const text = JSON.stringify(value);

      if (
        /Iron Wing|Team Spirit|TEAM VISION|BoomBoys|Team Liquid|Team Yandex|Nigma Galaxy|Team Falcons/i.test(text)
      ) {
        console.log('\nPATH:', path);
        console.dir(value, {
          depth: 4,
          colors: true
        });
      }
    }
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) =>
      scan(v, `${path}[${i}]`)
    );
  } else {
    for (const [key, child] of Object.entries(value)) {
      scan(child, `${path}.${key}`);
    }
  }
}

scan(data);

console.log('\n===== PLAYOFF NODES =====');

const nodes = collectLeagueNodes(data);

for (const node of nodes) {
  if (
    Number(node.node_id) >= 14 &&
    Number(node.node_id) <= 17
  ) {
    console.dir(node, {
      depth: 8,
      colors: true
    });
  }
}