import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile, renderProfile, runScripts } from '../src/profile.js';

test('保留未修改分节和注释，按顺序执行脚本', () => {
  const source = '#!MANAGED-CONFIG https://old.example/a interval=60\r\n# 上游说明\r\n[General]\r\nloglevel = notify\r\n\r\n[Rule]\r\n# 原有注释\r\nFINAL,DIRECT\r\n\r\n[Unknown]\r\nkeep = yes\r\n';
  const profile = parseProfile(source);
  const config = runScripts(profile, [
    { name: '前置规则', enabled: true, code: "module.exports = config => { config.rules = ['DOMAIN,first.test,DIRECT', ...config.rules]; return config; }" },
    { name: '第二步', enabled: true, code: "module.exports = config => { config.rules.splice(1, 0, 'DOMAIN,second.test,DIRECT'); return config; }" },
    { name: '禁用', enabled: false, code: "throw new Error('不应执行')" },
  ]);
  const output = renderProfile(profile, config, 'http://nas:3080/subscription', 3600);
  assert.match(output, /^#!MANAGED-CONFIG http:\/\/nas:3080\/subscription interval=3600\r\n/);
  assert.equal(output.match(/#!MANAGED-CONFIG/g).length, 1);
  assert.match(output, /\[General\]\r\nloglevel = notify\r\n\r\n\[Rule\]/);
  assert.match(output, /DOMAIN,first\.test,DIRECT\r\nDOMAIN,second\.test,DIRECT\r\n# 原有注释\r\nFINAL,DIRECT/);
  assert.match(output, /\[Unknown\]\r\nkeep = yes\r\n$/);
});

test('可按分节名直接访问配置、可新增规则分节，且执行错误包含脚本名称', () => {
  const profile = parseProfile('[General]\nloglevel = notify\n');
  const config = runScripts(profile, [{ name: '新增', enabled: true, code: "module.exports = config => { config['General'].push('dns-server = 223.5.5.5'); config.rules = ['FINAL,DIRECT']; return config; }" }]);
  assert.equal(config.sections, undefined);
  const output = renderProfile(profile, config, 'http://nas/subscription');
  assert.match(output, /\[General\]\nloglevel = notify\ndns-server = 223\.5\.5\.5/);
  assert.match(output, /\[Rule\]\nFINAL,DIRECT/);
  assert.throws(() => runScripts(profile, [{ name: '出错', enabled: true, code: "module.exports = () => { throw new Error('失败'); }" }]), /脚本「出错」执行失败：失败/);
});
