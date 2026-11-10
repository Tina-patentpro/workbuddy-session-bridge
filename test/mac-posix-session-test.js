'use strict';

// Regression for an observed macOS project directory, independent of slugifyPath.
// All fixtures are isolated; no real WorkBuddy queue/session is modified.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../lib/paths');
const sessions = require('../lib/sessions');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-posix-filter-'));
const layout = {
  workbuddyDir: root,
  projectsDir: path.join(root, 'projects'),
  sessionsIndexPath: path.join(root, 'app', 'sessions.json'),
  sessionIndexRoot: path.join(root, 'app'),
};
const workDir = '/Users/test/Projects/patent-library';
// Literal from the observed macOS naming convention; never produced by code under test.
const projectDir = path.join(layout.projectsDir, 'Users-test-Projects-patent-library');
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(layout.sessionIndexRoot, { recursive: true });
fs.writeFileSync(path.join(projectDir, 'known-session.jsonl'),
  JSON.stringify({ type: 'message', role: 'assistant', text: 'fixture' }) + '\n');

let failures = 0;
function check(name, body) {
  try { body(); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failures += 1; process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}
try {
  check('POSIX absolute path has no leading separator token', () => {
    assert.strictEqual(paths.slugifyPath(workDir), 'Users-test-Projects-patent-library');
  });
  check('POSIX path preserves Chinese and literal hyphens', () => {
    assert.strictEqual(paths.slugifyPath('/Users/test/专利-知识库'), 'Users-test-专利-知识库');
  });
  check('Windows drive slug is unchanged', () => {
    assert.strictEqual(paths.slugifyPath('C:\\Users\\Test\\Project'), 'c-Users-Test-Project');
  });
  check('Windows UNC slug is unchanged', () => {
    assert.strictEqual(paths.slugifyPath('\\\\server\\share\\project'), '-server-share-project');
  });
  check('Windows forward-slash UNC slug is unchanged', () => {
    assert.strictEqual(paths.slugifyPath('//server/share/project'), '-server-share-project');
  });
  check('project-scan exact workDir returns the observed folder', () => {
    const result = sessions.listSessions({ workDir, limit: 5, includeCounts: false }, layout);
    assert.strictEqual(result.indexSource, 'project-scan');
    assert.deepStrictEqual(result.sessions.map(item => item.conversationId), ['known-session']);
    assert.strictEqual(result.sessions[0].projectDir, projectDir);
    assert.strictEqual(result.sessions[0].workDir, null);
  });
  check('exact workDir never returns another project', () => {
    assert.strictEqual(sessions.listSessions({ workDir: '/Users/test/Projects/other', includeCounts: false }, layout).returned, 0);
  });
  check('indexed POSIX session resolves its literal project folder', () => {
    fs.writeFileSync(layout.sessionsIndexPath, JSON.stringify({ sessions: [{ conversationId: 'known-session', workDir }] }));
    const result = sessions.listSessions({ workDir, includeCounts: false }, layout);
    assert.strictEqual(result.indexSource, 'sessions.json');
    assert.strictEqual(result.sessions[0].resolvedVia, 'sessions.json');
    assert.strictEqual(result.sessions[0].fileExists, true);
    assert.strictEqual(result.sessions[0].filePath, path.join(projectDir, 'known-session.jsonl'));
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
process.stdout.write(`TOTAL 8 FAIL ${failures}\n`);
process.exitCode = failures ? 1 : 0;
