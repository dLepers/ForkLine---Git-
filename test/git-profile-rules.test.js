const { test } = require('node:test');
const assert = require('node:assert/strict');
const { globMatches, selectGitProfile } = require('../src/git-profile-rules');

test('matches Git profile glob rules', () => {
  assert.equal(globMatches('/home/daisy/projects/cead-back', '/home/*/projects/cead-*'), true);
  assert.equal(globMatches('git@gitlab.example.com:team/app.git', '*gitlab.example.com*team/app.git'), true);
  assert.equal(globMatches('/work/team1/app', '/work/team?/app'), true);
  assert.equal(globMatches('/home/daisy/other', '/home/*/projects/*'), false);
});

test('prefers an exact repository assignment over automatic rules', () => {
  const state = {
    gitProfiles: [
      { id: 'rule', label: 'Travail', pathPattern: '/work/*' },
      { id: 'exact', label: 'Personnel' },
    ],
    gitProfileAssignments: { '/work/project': 'exact' },
  };
  assert.deepEqual(selectGitProfile(state, '/work/project', []), { profile: state.gitProfiles[1], matchType: 'exact' });
});

test('selects the most specific matching path and remote rule', () => {
  const state = {
    gitProfiles: [
      { id: 'generic', label: 'Générique', pathPattern: '/work/*' },
      { id: 'specific', label: 'Équipe', pathPattern: '/work/team/*', remotePattern: '*gitlab.example.com*team/*' },
    ],
  };
  const result = selectGitProfile(state, '/work/team/app', ['git@gitlab.example.com:team/app.git']);
  assert.equal(result.profile.id, 'specific');
  assert.equal(result.matchType, 'rule');
});
