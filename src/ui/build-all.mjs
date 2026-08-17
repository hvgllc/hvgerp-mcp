/**
 * Build all ERPNext UI viewers individually.
 *
 * vite-plugin-singlefile doesn't support multiple inputs,
 * so we build each UI separately.
 */

import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Vite và toàn bộ trình cắm dựng viewer nằm ở `src/ui/node_modules`, mà thư mục đó bị
// `.gitignore` loại: một lần clone sạch KHÔNG có sẵn nó. Thiếu nó thì `npx vite build` bên dưới
// đi tải một bản Vite khác về rồi chết ở lệnh import trình cắm, và thông báo cuối cùng nói về
// một tệp cấu hình chứ không nói về bước cài còn thiếu. Chặn ngay tại đây để lỗi tự nói ra
// cách sửa.
try {
  statSync(resolve(__dirname, "node_modules", "vite"));
} catch {
  console.error(
    "src/ui/node_modules is missing (or incomplete). Run `deno task ui:install` " +
      "(equivalently `cd src/ui && npm ci`) before building the viewers.",
  );
  process.exit(1);
}

const skip = ["node_modules", "dist", "shared"];
const uis = readdirSync(__dirname).filter((entry) => {
  const entryPath = resolve(__dirname, entry);
  if (!statSync(entryPath).isDirectory()) return false;
  if (entry.startsWith(".") || skip.includes(entry)) return false;

  try {
    statSync(resolve(entryPath, "index.html"));
    return true;
  } catch {
    return false;
  }
});

console.log(`\nBuilding ${uis.length} ERPNext UIs: ${uis.join(", ")}\n`);

rmSync(resolve(__dirname, "dist"), { recursive: true, force: true });
mkdirSync(resolve(__dirname, "dist"), { recursive: true });

for (const ui of uis) {
  console.log(`Building ${ui}...`);

  try {
    execSync(`npx vite build --config vite.single.config.mjs`, {
      cwd: __dirname,
      stdio: "inherit",
      env: { ...process.env, UI_NAME: ui },
    });
    console.log(`${ui} built successfully\n`);
  } catch (error) {
    console.error(`Failed to build ${ui}\n`);
    process.exit(1);
  }
}

console.log(`\nAll ${uis.length} ERPNext UIs built successfully!`);
