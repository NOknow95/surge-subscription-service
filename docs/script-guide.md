# Surge 转换脚本编写指南（精简版）

用 JavaScript 按顺序修改上游 Surge 配置：脚本以配置对象为输入并返回处理后的对象，服务再把结果序列化为完整 Surge 配置。

本文是精简版。完整教程（含全部示例、保留规则与排查细节）在服务网页内：管理页右上角「查看脚本编写指南」，或直接打开 `/script-guide.html`；源码位于 [`public/script-guide.html`](../public/script-guide.html)。

## 执行流程

1. Surge 请求 `/subscription` 时，服务重新拉取上游完整配置；
2. 服务解析配置分节，把每个分节的非空行整理为行数组（注释保留）；
3. 服务按管理页显示顺序执行所有**已启用**脚本，后一个脚本收到前一个脚本返回的配置；
4. 服务写入 `#!MANAGED-CONFIG` 行后，把完整配置返回给 Surge。

## 可用配置对象

脚本接收一个 `config` 对象，可以直接按分节名读写：

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| `config['分节名']` | 该分节的字符串数组，`config` 本身以分节名为键。每项对应一条非空配置行，注释保留、空行过滤；分节不存在时可先赋空数组创建 | `config['General'].push('loglevel = notify')` |
| `config.rules` | `[Rule]` 的快捷入口，与 `config['Rule']` 指向同一数组；赋新数组即替换该分节内容 | `config.rules.unshift('FINAL,DIRECT')` |

分节名区分大小写：`config['Rule']` 对应 `[Rule]`，`config['Proxy Group']` 对应 `[Proxy Group]`。

## 最小模板

```js
module.exports = (config) => {
  // 在这里读取或修改 config['General'] / config.rules

  return config;
};
```

脚本必须通过 `module.exports` 导出函数并返回配置对象；即使不做修改也要 `return config`。

## 常用示例

### 1. 在现有规则前添加规则

新规则先匹配，注意不要遮蔽上游中更具体的规则。

```js
module.exports = (config) => {
  config.rules = [
    'DOMAIN-SUFFIX,docker.io,节点选择',
    'DOMAIN-SUFFIX,docker.com,节点选择',
    ...(config.rules || []),
  ];
  return config;
};
```

### 2. 把规则插入到 FINAL 前

末尾追加的规则排在 `FINAL` 之后通常不会生效，需要精确插到它前面时用这个写法。

```js
module.exports = (config) => {
  const rule = 'DOMAIN-SUFFIX,example.org,DIRECT';
  const finalIndex = config.rules.findIndex(line => /^\s*FINAL,/i.test(line));

  if (finalIndex === -1) {
    config.rules.push(rule);
  } else {
    config.rules.splice(finalIndex, 0, rule);
  }

  return config;
};
```

### 3. 删除匹配的规则

用 `filter` 返回要保留的行，其他规则和注释不受影响。

```js
module.exports = (config) => {
  config.rules = config.rules.filter(line =>
    !line.startsWith('DOMAIN-SUFFIX,old.example,')
  );
  return config;
};
```

### 4. 修改其他分节

给 `[General]` 换 DNS，或创建一个上游没有的分节。

```js
module.exports = (config) => {
  config['General'] ||= [];
  config['General'] = config['General'].filter(
    line => !/^dns-server\s*=/i.test(line)
  );
  config['General'].push('dns-server = 223.5.5.5');

  config['URL Rewrite'] ||= [];
  config['URL Rewrite'].push(
    '^https?://example\\.com https://www.example.com 302'
  );

  return config;
};
```

删除整个分节用 `delete config['URL Rewrite']`。只读取、不修改的分节会原样保留。

## 输出规则

- 未被脚本改动的分节原文保留，包括注释、内部空行和行顺序；
- 被改动的分节按脚本返回的数组重写，数组里的空行会被过滤；
- 相邻分节标题之间统一保留一个空行；
- 一个数组元素对应一行，不能含换行符；分节名不能含方括号或换行符；
- 输入中原有的 `#!MANAGED-CONFIG` 会被替换为指向本服务的托管链接；
- 脚本新建的分节追加到配置末尾；同名重复分节会聚合给脚本，修改后合并到第一个同名分节的位置。

## 限制与失败行为

- 只能同步执行：不要用 `async`、Promise、网络请求、定时器或文件操作；
- 单个脚本最长运行 500 毫秒；脚本名称最多 100 字符，代码最多 100000 字符；
- 脚本必须返回配置对象，分节内容必须是字符串数组；
- 任一脚本出错会导致本次转换整体失败，不会发布部分结果；若已有成功结果，服务返回上次成功的完整配置，管理页显示错误；
- 脚本是管理员提供的**受信任代码**，运行时使用的 `node:vm` 不是安全隔离边界，不要粘贴来源不明的脚本。

## 在管理页中添加脚本

1. 在「转换脚本」区域点击「新增脚本」；
2. 填写名称、粘贴代码，确认「启用」已勾选；
3. 保存后用上下箭头调整执行顺序，可随时编辑、禁用或删除；
4. 点击「立即拉取并转换」，再点「查看上次成功配置」，检查规则、分节和托管链接是否符合预期。

规则顺序会影响行为，重点检查自己添加的规则与 `FINAL` 的相对位置。
