import {parseArgs} from 'util';
import {join} from 'path';
import MicroStudio from './micro_studio.js';
import ProjectBridge from './project_bridge.js';

const {values: args} = parseArgs({
  args: process.argv.slice(2),
  options: {
    directory: {type: 'string', short: 'd'},
    token: {type: 'string', short: 't'},
    project: {type: 'string', multiple: true, short: 'p'},
    help: {type: 'boolean', short: 'h'},
  }
});

if (args.help) {
  console.log(`
Keeps files from microStudio in sync with the local file system.
  --token TOKEN
    The security token for your session. You can find it in the cookies stored for microstudio.dev.
    Note that it changes every time you sign in!
  --directory PATH
    The directory where projects are to be stored, relative to the current working directory.
  --project NAME
    The microStudio projects to sync; can be provided multiple times.  Use the slug from the URL,
    not the human-readable display name.  If omitted, syncs all projects.
  --help
    Print this usage summary.
`);
  process.exit(0);
}

if (!args.token) {
  console.error('You must specify a `--token`.');
  process.exit(1);
}

const projectBridges = new Map();

const microStudio = new MicroStudio(args.token, event => {
  if (event.project && projectBridges.has(event.project)) {
    projectBridges.get(event.project).handleEvent(event);
  }
});
await microStudio.ready;

const projects = await microStudio.request('get_project_list', {}, 'project_list');
for (const project of projects.list) {
  if (!args.project || args.project.includes(project.slug)) {
    const bridge = new ProjectBridge(
      project.id, join(args.directory ?? '', project.slug), project.language, microStudio);
    projectBridges.set(project.id, bridge);
  }
}
