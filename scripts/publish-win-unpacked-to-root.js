const fs = require('fs-extra');
const path = require('path');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const packagedDir = path.join(projectRoot, 'dist', 'win-unpacked');

  if (!(await fs.pathExists(packagedDir))) {
    throw new Error(`Packaged app not found: ${packagedDir}`);
  }

  const entries = await fs.readdir(packagedDir);

  for (const entry of entries) {
    const source = path.join(packagedDir, entry);
    const destination = path.join(projectRoot, entry);

    if (path.resolve(destination) === path.resolve(packagedDir)) {
      throw new Error('Refusing to copy packaged output into itself.');
    }

    await fs.copy(source, destination, {
      overwrite: true,
      errorOnExist: false,
    });
  }

  console.log(`Published packaged app to ${projectRoot}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
