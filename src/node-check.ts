// Runs first, before anything that needs a newer Node.js.
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`Crew Jobs needs Node.js 22 or newer. This computer has Node.js ${process.versions.node}.`);
  console.error('Install the LTS version from https://nodejs.org, then run npm start again.');
  process.exit(1);
}
