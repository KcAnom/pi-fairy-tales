/** Minimal glob→RegExp for path rules: supports **, *, ? — no dependency. */

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more path segments; bare "**" matches anything
        if (glob[i + 2] === "/") {
          re += "(?:[^/]*/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  cache.set(glob, compiled);
  return compiled;
}

/** Match an absolute or relative path against a glob; globs without a leading
 *  slash or ** are treated as matching any suffix of the path. */
export function pathMatches(glob: string, path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (globToRegExp(glob).test(normalized)) return true;
  // "**/x" style globs already cover suffixes; for bare names like ".env*",
  // test against the basename too.
  if (!glob.includes("/")) {
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    return globToRegExp(glob).test(base);
  }
  return false;
}
