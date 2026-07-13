function parseCommandLine(command) {
  const input = String(command || '').trim();
  if (!input || /[\0\r\n]/.test(input)) throw new Error('Commande d’éditeur externe invalide.');
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  let started = false;
  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
      started = true;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = '';
        started = false;
      }
    } else {
      token += character;
      started = true;
    }
  }
  if (escaped || quote) throw new Error('Guillemets ou échappement incomplets dans la commande d’éditeur externe.');
  if (started) tokens.push(token);
  if (!tokens.length || tokens[0].startsWith('-')) throw new Error('Exécutable d’éditeur externe invalide.');
  return { executable: tokens[0], args: tokens.slice(1) };
}

function launchDetached(executable, args, cwd, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { cwd, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

module.exports = { parseCommandLine, launchDetached };
const { spawn } = require('node:child_process');
