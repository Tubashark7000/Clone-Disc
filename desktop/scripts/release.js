"use strict";
// Gera uma nova versão do app e publica o necessário para a atualização automática.
//
//   npm run release                      sobe a versão (patch), gera instalador + portátil e publica
//   npm run release -- --minor           1.0.5 -> 1.1.0   (ou --major)
//   npm run release -- --no-bump         mantém a versão atual
//   npm run release -- --no-build        não compila: só republica o que já está em dist/
//   npm run release -- --notes="texto"   mensagem exibida no aviso de atualização
//   npm run release -- --base-url=https://github.com/USUARIO/REPO/releases/download/v1.0.5
//                                        os .exe ficam nesse endereço (ex.: GitHub Releases) em vez do servidor
//
// Resultado: server/updates/latest.json (+ os .exe, se não usar --base-url). Depois é só commitar e enviar
// (git push) para o servidor reimplantar; os apps instalados passam a oferecer a atualização.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const pkgFile = path.join(root, "package.json");
const distDir = path.join(root, "dist");
const updatesDir = path.join(root, "..", "server", "updates");

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const fail = (msg) => {
  console.error(`\nERRO: ${msg}`);
  process.exit(1);
};

// 1) versão
const raw = fs.readFileSync(pkgFile, "utf8");
let version = JSON.parse(raw).version;
if (!has("no-build") && !has("no-bump")) {
  const [major, minor, patch] = version.split(".").map(Number);
  const next = has("major") ? [major + 1, 0, 0] : has("minor") ? [major, minor + 1, 0] : [major, minor, patch + 1];
  const nextVersion = next.join(".");
  fs.writeFileSync(pkgFile, raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${nextVersion}$2`));
  console.log(`Versão: ${version} -> ${nextVersion}`);
  version = nextVersion;
} else {
  console.log(`Versão: ${version}`);
}

// 2) compila (instalador + portátil)
if (!has("no-build")) {
  const res = spawnSync("npx", ["electron-builder", "--win", "nsis", "portable"], { cwd: root, stdio: "inherit", shell: true });
  if (res.status !== 0) {
    fs.writeFileSync(pkgFile, raw); // desfaz a troca de versão
    fail("o electron-builder falhou (veja as mensagens acima). Rode isto no Windows. A versão não foi alterada.");
  }
}

// 3) confere os arquivos gerados
const setupName = `Voidisce-Setup-${version}.exe`;
const portableBuilt = "Voidisce-Portable.exe";
const setupFile = path.join(distDir, setupName);
const portableFile = path.join(distDir, portableBuilt);
for (const f of [setupFile, portableFile]) {
  if (!fs.existsSync(f)) fail(`não encontrei ${path.relative(root, f)}. Rode sem --no-build.`);
}

const describe = (file, publishedName) => {
  const buf = fs.readFileSync(file);
  return {
    name: publishedName,
    file,
    size: buf.length,
    sha512: crypto.createHash("sha512").update(buf).digest("base64"),
  };
};
const setup = describe(setupFile, setupName);
const portable = describe(portableFile, `Voidisce-Portable-${version}.exe`);

// 4) publica em server/updates
const baseUrl = (value("base-url") ?? "").replace(/\/+$/, "");
fs.mkdirSync(updatesDir, { recursive: true });
for (const f of fs.readdirSync(updatesDir)) {
  if (/^Voidisce-.*\.exe$/i.test(f)) fs.rmSync(path.join(updatesDir, f), { force: true }); // apaga versões antigas
}
if (!baseUrl) {
  fs.copyFileSync(setup.file, path.join(updatesDir, setup.name));
  fs.copyFileSync(portable.file, path.join(updatesDir, portable.name));
}

const urlOf = (item) => (baseUrl ? `${baseUrl}/${item.name}` : item.name);
const manifest = {
  version,
  releasedAt: new Date().toISOString(),
  ...(value("notes") ? { notes: value("notes") } : {}),
  setup: { url: urlOf(setup), sha512: setup.sha512, size: setup.size },
  portable: { url: urlOf(portable), sha512: portable.sha512, size: portable.size },
};
fs.writeFileSync(path.join(updatesDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`\nPronto: versão ${version}`);
console.log(`  instalador: ${setup.name} (${mb(setup.size)})`);
console.log(`  portátil:   ${portable.name} (${mb(portable.size)})`);
console.log(`  manifesto:  server/updates/latest.json`);
if (baseUrl) {
  console.log(`\nAgora envie estes dois arquivos para ${baseUrl}/ :`);
  console.log(`  ${path.relative(process.cwd(), setup.file)}   (publicar como ${setup.name})`);
  console.log(`  ${path.relative(process.cwd(), portable.file)}   (publicar como ${portable.name})`);
}
console.log("\nPróximo passo: commit e git push (o servidor reimplanta e os apps passam a oferecer a atualização).");
