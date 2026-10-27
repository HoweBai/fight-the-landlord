#!/usr/bin/env node
/**
 * k8s 清单机械闸（spec 2026-10-27 §6.1）。
 *
 * 用法：node scripts/verify-k8s-manifests.mjs [--dir k8s]
 * 退出码：0 = 通过；1 = 有违规。
 *
 * 只做**静态**断言；真集群的 kubectl dry-run / HPA / 网络行为在预演环境验收。
 * 判别力由 scripts/fixtures/k8s-{valid,invalid} 自证（见 plan Task A1）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import yaml from 'js-yaml';

const dirIdx = process.argv.indexOf('--dir');
const fileIdx = process.argv.indexOf('--file');
const FILE_MODE = fileIdx > -1;
const ROOT = resolve(dirIdx > -1 ? process.argv[dirIdx + 1] : 'k8s');
const FILE = FILE_MODE ? resolve(process.argv[fileIdx + 1]) : null;
const errors = [];
const docs = [];

function pushDocs(source, text) {
  let parsed;
  try {
    parsed = yaml.loadAll(text);
  } catch (err) {
    errors.push(`${source}: YAML 解析失败：${String(err)}`);
    return;
  }
  for (const d of parsed) {
    if (d && typeof d === 'object' && d.kind) docs.push({ p: source, d });
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.ya?ml$/.test(name)) pushDocs(p, readFileSync(p, 'utf8'));
  }
}

try {
  if (FILE_MODE) pushDocs(FILE, readFileSync(FILE, 'utf8'));
  else walk(ROOT);
} catch (err) {
  console.error(`❌ 输入不可读：${FILE_MODE ? FILE : ROOT}（${String(err)}）`);
  process.exit(1);
}

const all = (kind) => docs.filter(({ d }) => d.kind === kind).map(({ d }) => d);
const named = (kind, name) => all(kind).find((d) => d.metadata?.name === name);
const imageOk = (image) => {
  if (typeof image !== 'string') return false;
  if (image.includes('IMAGE_TAG_PLACEHOLDER')) return true;
  return image.includes(':') && !image.endsWith(':latest');
};

if (!FILE_MODE && !all('Namespace').some((d) => d.metadata?.name === 'ftl')) {
  errors.push('缺 Namespace/ftl');
}

// kustomization 收录完整性：base 下每个顶层 YAML 都必须被 resources 引用（防「文件存在但没 apply」假绿）。
if (!FILE_MODE) {
  const kdir = existsSync(join(ROOT, 'base', 'kustomization.yaml'))
    ? join(ROOT, 'base')
    : existsSync(join(ROOT, 'kustomization.yaml'))
      ? ROOT
      : null;
  if (kdir) {
    let k;
    try {
      k = yaml.load(readFileSync(join(kdir, 'kustomization.yaml'), 'utf8')) ?? {};
    } catch (err) {
      errors.push(`kustomization.yaml 不可解析：${String(err)}`);
    }
    if (k) {
      const listed = new Set((k.resources ?? []).map(String));
      for (const f of readdirSync(kdir)) {
        if (!/\.ya?ml$/.test(f) || f === 'kustomization.yaml') continue;
        if (!listed.has(f)) errors.push(`kustomization 未收录 ${f}`);
      }
      for (const g of k.configMapGenerator ?? []) {
        for (const f of g.files ?? []) {
          if (!existsSync(join(kdir, f))) errors.push(`configMapGenerator 文件不存在：${f}`);
        }
      }
      for (const rel of ['overlays/prod/kustomization.yaml', 'overlays/migrate/kustomization.yaml']) {
        const p = join(dirname(kdir), rel);
        if (!existsSync(p) || !readFileSync(p, 'utf8').includes('ghcr-pull')) {
          errors.push(`${rel}: 缺 imagePullSecrets(ghcr-pull) 注入`);
        }
      }
    }
  }
}

const workloadKinds = ['Deployment', 'StatefulSet', 'DaemonSet'];
const workloads = workloadKinds.flatMap((kind) => all(kind).map((d) => ({ kind, d })));

for (const { kind, d } of workloads) {
  const name = `${kind}/${d.metadata?.name ?? '<unnamed>'}`;
  if (!d.metadata?.namespace) errors.push(`${name}: 缺 metadata.namespace`);
  const podSpec = d.spec?.template?.spec;
  if (!podSpec) {
    errors.push(`${name}: 缺 pod 模板`);
    continue;
  }
  for (const c of podSpec.containers ?? []) {
    const cn = `${name}/${c.name ?? '<unnamed>'}`;
    if (!c.resources?.requests || !c.resources?.limits) errors.push(`${cn}: 缺 requests/limits`);
    if (!c.readinessProbe) errors.push(`${cn}: 缺 readinessProbe`);
    if (!imageOk(c.image)) errors.push(`${cn}: 镜像必须是显式 tag 或 IMAGE_TAG_PLACEHOLDER（禁 :latest）`);
  }
  for (const c of podSpec.initContainers ?? []) {
    const cn = `${name}/${c.name ?? '<unnamed>'}`;
    if (!c.resources?.requests || !c.resources?.limits) errors.push(`${cn}: 缺 requests/limits`);
    if (!imageOk(c.image)) errors.push(`${cn}: 镜像必须是显式 tag 或 IMAGE_TAG_PLACEHOLDER（禁 :latest）`);
  }
}

const singleInstance = ['mysql', 'redis', 'edge', 'game-service', 'config-service'];
for (const name of singleInstance) {
  const found = workloads.find(({ d }) => d.metadata?.name === name);
  if (!found) {
    errors.push(`缺单实例工作负载 ${name}`);
    continue;
  }
  if (found.kind === 'Deployment' && found.d.spec?.strategy?.type !== 'Recreate') {
    errors.push(`${name}: 单实例 Deployment 必须 strategy.type=Recreate`);
  }
  const podSpec = found.d.spec?.template?.spec;
  if (podSpec?.nodeSelector?.['ftl-role'] !== 'data') {
    errors.push(`${name}: 必须钉 nodeSelector ftl-role=data`);
  }
}

for (const name of ['mysql', 'redis']) {
  const found = workloads.find(({ d }) => d.metadata?.name === name);
  if (!found) continue;
  const vcts = found.d.spec?.volumeClaimTemplates ?? [];
  if (!vcts.some((v) => v.spec?.storageClassName === 'local-path')) {
    errors.push(`${name}: volumeClaimTemplates 必须用 storageClassName=local-path`);
  }
  for (const c of found.d.spec?.template?.spec?.containers ?? []) {
    const req = c.resources?.requests;
    const lim = c.resources?.limits;
    const guaranteed =
      req?.cpu === lim?.cpu && req?.memory === lim?.memory && req?.cpu !== undefined && req?.memory !== undefined;
    if (!guaranteed) errors.push(`${name}/${c.name}: 数据层必须 Guaranteed（requests=limits）`);
  }
}

const edge = named('Deployment', 'edge');
if (edge && edge.spec?.template?.spec?.hostNetwork !== true) {
  errors.push('edge: 必须 hostNetwork=true（保真实客户端 IP）');
}

for (const name of ['room-service', 'api-gateway']) {
  const pdb = named('PodDisruptionBudget', `${name}-pdb`);
  if (!pdb) errors.push(`缺 PDB ${name}-pdb`);
  else if ((pdb.spec?.minAvailable ?? 0) < 1) errors.push(`PDB ${name}-pdb: minAvailable 必须 ≥ 1`);
}

const hpaNames = ['room-service', 'api-gateway', 'robot-service', 'user-service', 'currency-service', 'payment-service'];
for (const name of hpaNames) {
  const hpa = named('HorizontalPodAutoscaler', `${name}-hpa`);
  if (!hpa) {
    errors.push(`缺 HPA ${name}-hpa`);
    continue;
  }
  const win = hpa.spec?.behavior?.scaleDown?.stabilizationWindowSeconds;
  if (typeof win !== 'number' || win < 600) {
    errors.push(`HPA ${name}-hpa: scaleDown.stabilizationWindowSeconds 必须 ≥ 600`);
  }
}

const deny = named('NetworkPolicy', 'default-deny');
if (!deny) errors.push('缺 NetworkPolicy/default-deny');
else {
  const types = deny.spec?.policyTypes ?? [];
  if (!types.includes('Ingress') || !types.includes('Egress')) {
    errors.push('NetworkPolicy/default-deny: policyTypes 必须同时含 Ingress 与 Egress');
  }
}

if (docs.some(({ d }) => d.kind === 'Secret')) errors.push('禁止提交 Secret（由 runbook 在集群内创建）');
if (docs.some(({ d }) => JSON.stringify(d).includes('"container_name"'))) {
  errors.push('禁止 container_name');
}

if (errors.length) {
  console.error(`❌ k8s 清单闸失败（${errors.length} 项，目录 ${ROOT}）：\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
console.log(`✅ k8s 清单闸通过（${docs.length} 个文档，目录 ${ROOT}）`);
