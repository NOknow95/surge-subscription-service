import vm from 'node:vm';

const sectionPattern = /^\[([^\]\r\n]+)\][ \t]*$/;
const managedPattern = /^#!MANAGED-CONFIG(?:\s|$)/i;
const sectionsByConfig = new WeakMap();

export function parseProfile(source) {
  if (typeof source !== 'string' || !sectionPattern.test(source.split(/\r?\n/, 1)[0]) && !/^\[.+\]/m.test(source)) {
    throw new Error('上游响应不是完整的 Surge 分节配置');
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const trailingNewline = lines.at(-1) === '';
  if (trailingNewline) lines.pop();
  const blocks = [{ name: null, header: null, lines: [] }];
  for (const line of lines) {
    const match = line.match(sectionPattern);
    if (match) blocks.push({ name: match[1], header: line, lines: [] });
    else blocks.at(-1).lines.push(line);
  }
  if (blocks.length === 1) throw new Error('上游响应缺少 Surge 分节');
  const sections = Object.create(null);
  for (const block of blocks.slice(1)) {
    if (!sections[block.name]) sections[block.name] = [];
    sections[block.name].push(...block.lines.filter(line => line.trim() !== ''));
  }
  const original = structuredClone(sections);
  if (!sections.Rule) sections.Rule = [];
  return { blocks, sections, original, newline, trailingNewline };
}

function scriptConfig(sections) {
  const config = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === 'rules') return sections.Rule;
      return typeof property === 'string' ? sections[property] : undefined;
    },
    set(_target, property, value) {
      if (typeof property !== 'string') return false;
      sections[property === 'rules' ? 'Rule' : property] = value;
      return true;
    },
    deleteProperty(_target, property) {
      if (typeof property !== 'string') return false;
      return delete sections[property === 'rules' ? 'Rule' : property];
    },
    ownKeys() {
      return [...new Set([...Reflect.ownKeys(sections), 'rules'])];
    },
    getOwnPropertyDescriptor(_target, property) {
      if (property === 'rules') {
        return { configurable: true, enumerable: true, writable: true, value: sections.Rule };
      }
      if (typeof property === 'string' && Object.hasOwn(sections, property)) {
        return { configurable: true, enumerable: true, writable: true, value: sections[property] };
      }
      return undefined;
    },
  });
  sectionsByConfig.set(config, sections);
  return config;
}

function sectionMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const knownSections = sectionsByConfig.get(value);
  if (knownSections) return knownSections;

  const sections = Object.create(null);
  for (const [name, lines] of Object.entries(value)) {
    sections[name === 'rules' ? 'Rule' : name] = lines;
  }
  return sections;
}

export function runScripts(profile, scripts) {
  let config = scriptConfig(profile.sections);
  for (const script of scripts.filter(item => item.enabled)) {
    try {
      const context = vm.createContext({ module: { exports: undefined }, config });
      const result = new vm.Script(`${script.code}\n;(() => { if (typeof module.exports !== 'function') throw new Error('脚本必须导出函数'); return module.exports(config); })()`)
        .runInContext(context, { timeout: 500 });
      if (result && typeof result.then === 'function') throw new Error('暂不支持异步脚本');
      const sections = sectionMap(result);
      if (!sections) throw new Error('脚本必须返回配置对象');
      validateSections(sections);
      config = scriptConfig(sections);
    } catch (error) {
      throw new Error(`脚本「${script.name}」执行失败：${error.message}`);
    }
  }
  return config;
}

function validateSections(sections) {
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) throw new Error('sections 必须是对象');
  for (const [name, lines] of Object.entries(sections)) {
    if (!name || /[\]\r\n]/.test(name)) throw new Error(`无效分节名：${name}`);
    if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string' || /[\r\n]/.test(line))) {
      throw new Error(`分节「${name}」必须是单行字符串数组`);
    }
  }
}

export function renderProfile(profile, config, subscriptionUrl, interval = 86400) {
  const sections = sectionMap(config);
  validateSections(sections);
  const { blocks, original, newline, trailingNewline } = profile;
  const output = [`#!MANAGED-CONFIG ${subscriptionUrl} interval=${interval}`];
  const preamble = blocks[0].lines.filter(line => !managedPattern.test(line));
  output.push(...preamble);
  const emitted = new Set();
  let hasSection = false;
  const appendSection = (header, lines) => {
    if (hasSection) {
      while (output.at(-1) === '') output.pop();
      output.push('');
    }
    output.push(header, ...lines);
    hasSection = true;
  };
  for (const block of blocks.slice(1)) {
    if (emitted.has(block.name) || !Object.hasOwn(sections, block.name)) continue;
    const changed = JSON.stringify(sections[block.name]) !== JSON.stringify(original[block.name]);
    appendSection(block.header, changed ? sections[block.name] : block.lines);
    if (changed) emitted.add(block.name);
  }
  for (const [name, lines] of Object.entries(sections)) {
    if (name === 'Rule' && !Object.hasOwn(original, name) && !lines.some(line => line.trim() !== '')) continue;
    if (Object.hasOwn(original, name)) continue;
    appendSection(`[${name}]`, lines);
  }
  return output.join(newline) + (trailingNewline ? newline : '');
}
