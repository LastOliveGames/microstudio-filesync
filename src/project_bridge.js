import chokidar from 'chokidar';
import {createHash} from 'crypto';
import {basename, dirname, join, relative, sep} from 'path';
import {promises} from 'fs';
const {mkdir, readFile, unlink, writeFile} = promises;


const VALID_FOLDERS = ['ms', 'sprites', 'maps', 'sounds', 'music', 'assets'];
const SYNCABLE_REGEX = new RegExp(`^[\\w\\${sep}]+$`);

export default class ProjectBridge {
  #id;
  #directory;
  #extension;
  #state;
  #microStudio;

  constructor(id, directory, language, microStudio) {
    this.#id = id;
    this.#directory = directory;
    this.#extension =
      language === 'javascript' ? '.js' :
      language === 'python' ? '.py' :
      language === 'lua' ? '.lua' :
      null;
    this.#microStudio = microStudio;
    this.#syncProject();
  }

  async #syncProject() {
    try {
      console.log('Syncing', this.#directory);
      await this.#loadState();
      await mkdir(this.#directory, {recursive: true});
      await Promise.all([
        ...VALID_FOLDERS.map(folder => this.#syncFolder(folder)),
        this.#syncFolder('doc')
      ]);
      chokidar.watch(join(process.cwd(), this.#directory), {
        cwd: process.cwd(), atomic: true,
        ignored: path => {
          path = relative('', path).replace(/\.[^.]+$/, '');
          return !(path && !path.endsWith(sep) && SYNCABLE_REGEX.test());
        }
      }).on('all', (event, path) => this.#handleLocalChange(event, path))
    } catch (e) {
      console.error(e.stack);
      process.exit(1);
    }
  }

  async #syncFolder(folder) {
    const listResponse =
      await this.#microStudio.request('list_project_files', {project: this.#id, folder});
    await Promise.all(listResponse.files.map(async file => {
      const filename = `${folder}/${file.file}`;
      if (file.version !== this.#state[filename]?.version) {
        await this.#downloadFile(filename, file.version);
      }
    }));
  }

  async #downloadFile(filename, version) {
    const fileResponse = await this.#microStudio.request(
      'read_project_file', {project: this.#id, file: filename});
    this.#writeFile(filename, fileResponse.content, version);
  }

  async #writeFile(filename, content, version) {
    const filePath = join(this.#directory, this.#filenameToLocal(filename));
    await mkdir(dirname(filePath), {recursive: true});
    await writeFile(filePath, Buffer.from(content, getEncoding(filename)));
    const hash = hashFile(content);
    this.#state[filename] = {version, hash};
    await this.#saveState();
  }

  async #uploadFile(path) {
    const filename = this.#filenameToRemote(relative(this.#directory, path));
    if (!filename) return;
    const buffer = await readFile(path);
    const content = buffer.toString(getEncoding(filename));
    const hash = hashFile(content);
    if (hash === this.#state[filename]?.hash) return;
    const writeResponse = await this.#microStudio.request(
      'write_project_file', {project: this.#id, file: filename, characters: 0, lines: 0, content});
    this.#state[filename] = {version: writeResponse.version, hash};
    await this.#saveState();
  }

  async #deleteLocalFile(filename) {
    try {
      await unlink(join(this.#directory, this.#filenameToLocal(filename)));
      delete this.#state[filename];
      this.#saveState();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  async #deleteRemoteFile(path) {
    const filename = this.#filenameToRemote(relative(this.#directory, path));
    if (!filename) return;
    // Are there files that need `thumbnail: true`?
    await this.#microStudio.request(
      'delete_project_file', {project: this.#id, file: filename, thumbnail: false});
    delete this.#state[filename];
    this.#saveState();
  }

  async #handleLocalChange(type, path) {
    try {
      switch (type) {
        case 'add':
        case 'change':
          await this.#uploadFile(path);
          break;
        case 'unlink':
          await this.#deleteRemoteFile(path);
          break;
      }
    } catch (e) {
      console.error(e.stack);
      process.exit(1);
    }
  }

  async handleEvent(event) {
    try {
      switch (event.name) {
        case 'project_file_update':
          await this.#writeFile(event.file, event.content, event.version);
          break;
        case 'project_file_deleted':
          await this.#deleteLocalFile(event.file);
      }
    } catch (e) {
      console.error(e.stack);
      process.exit(1);
    }
  }

  #filenameToLocal(filename) {
    filename = filename.replaceAll('-', sep);
    if (filename.startsWith('ms/')) {
      filename = filename.replace(/^ms/, 'src');
      if (this.#extension) filename = filename.replace(/\.ms$/, this.#extension);
    }
    return filename;
  }

  #filenameToRemote(filename) {
    const segments = [];
    while (filename !== '.') {
      segments.unshift(basename(filename));
      filename = dirname(filename);
    }
    if (segments[0] === 'src') {
      segments[0] = 'ms';
      if (this.#extension) {
        segments[segments.length - 1] =
          segments[segments.length - 1].replace(new RegExp(`\\${this.#extension}$`), '.ms');
      }
    }
    const valid = segments.length >= 2 && (
      VALID_FOLDERS.includes(segments[0]) || segments.join('/') === 'doc/doc.md'
    );
    if (!valid) return;
    return `${segments[0]}/${segments.slice(1).join('-')}`;
  }

  async #loadState() {
    try {
      this.#state = JSON.parse(await readFile(join(this.#directory, '.sync-state')));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.#state = {};
    }
  }

  async #saveState() {
    await writeFile(
      join(this.#directory, '.sync-state'), JSON.stringify(this.#state, undefined, 2));
  }
}


function hashFile(content) {
  const hasher = createHash('sha256');
  hasher.update(content);
  return hasher.digest('hex');
}

function getEncoding(filename) {
  return /\.(ms|json|md|txt|csv)$/.test(filename) ? 'utf8' : 'base64';
}
