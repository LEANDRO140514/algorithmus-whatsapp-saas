import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

function candidateUrls(specifier, parentURL) {
  const urls = [];
  if (specifier.startsWith("@/")) {
    const root = pathToFileURL(
      join(process.cwd(), "src", specifier.slice(2)),
    ).href;
    urls.push(root);
  } else if (specifier.startsWith(".")) {
    urls.push(new URL(specifier, parentURL).href);
  } else {
    return urls;
  }

  const expanded = [];
  for (const url of urls) {
    expanded.push(url);
    if (url.endsWith(".js")) expanded.push(url.slice(0, -3) + ".ts");
    else if (!/\.[a-z]+$/i.test(url.split("/").pop() ?? "")) {
      expanded.push(url + ".ts");
    }
  }
  return expanded;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/") || specifier.startsWith(".")) {
    for (const url of candidateUrls(specifier, context.parentURL)) {
      const path = fileURLToPath(url);
      if (existsSync(path)) {
        return { url, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
