// 사용법: npm run release -- 0.4.1
// 버전 올리기 → 커밋 → 태그 → 푸시 (GitHub Actions가 dmg를 빌드해 Releases에 올림)
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v || "")) {
  console.error("사용법: npm run release -- 0.4.1");
  process.exit(1);
}
const sh = (c) => execSync(c, { stdio: "inherit" });
const out = (c) => execSync(c).toString().trim();

if (out("git status --porcelain")) {
  console.error("커밋하지 않은 변경이 있어요. 먼저 커밋한 뒤 다시 실행하세요.\n  git add . && git commit -m \"...\"");
  process.exit(1);
}
if (out(`git tag -l v${v}`)) {
  console.error(`v${v} 태그가 이미 있어요. 더 높은 버전을 쓰세요.`);
  process.exit(1);
}

const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, "utf8")));
edit("package.json", (s) => JSON.stringify({ ...JSON.parse(s), version: v }, null, 2) + "\n");
edit("src-tauri/tauri.conf.json", (s) => JSON.stringify({ ...JSON.parse(s), version: v }, null, 2) + "\n");
edit("src-tauri/Cargo.toml", (s) => s.replace(/^version = ".*"$/m, `version = "${v}"`));
edit("src-tauri/Cargo.lock", (s) => s.replace(/(name = "planner"\nversion = )".*"/, `$1"${v}"`));

sh("git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
sh(`git commit -m "release: v${v}"`);
sh(`git tag v${v}`);
sh(`git push`);
sh(`git push origin v${v}`);

const remote = out("git remote get-url origin").replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
console.log(`\n✓ v${v} 푸시 완료. 10~15분 뒤 여기서 dmg를 받을 수 있어요:\n  ${remote}/releases\n  빌드 진행 상황: ${remote}/actions`);
