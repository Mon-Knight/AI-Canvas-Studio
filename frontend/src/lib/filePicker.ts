const DEFAULT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/**
 * Open a native image file picker safely across Electron desktop and Web.
 *
 * In Electron desktop on Windows, calling `<input type="file">.click()` enters an
 * in-process modal Win32 COM loop on the main UI thread and sets WS_DISABLED on
 * the canvas window, risking permanent freezes on explorer shell extensions.
 * Delegating to `window.flowboardDesktop.pickImages()` runs the dialog in an
 * isolated helper process and keeps the Electron window 100% responsive.
 */
export async function pickImageFiles(opts?: {
  multiple?: boolean;
  accept?: string;
  title?: string;
}): Promise<File[]> {
  if (typeof window !== "undefined" && window.flowboardDesktop?.pickImages) {
    const res = await window.flowboardDesktop.pickImages({
      multiple: opts?.multiple,
      title: opts?.title,
    });
    if (res.error) {
      throw new Error(res.error);
    }
    if (res.canceled || res.files.length === 0) {
      return [];
    }
    return res.files.map(
      (item) => new File([new Uint8Array(item.bytes)], item.name, { type: item.mime }),
    );
  }

  return new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = opts?.accept ?? DEFAULT_ACCEPT;
    input.multiple = Boolean(opts?.multiple);
    input.style.display = "none";

    let settled = false;
    let focusTimer: number | null = null;

    const cleanup = () => {
      if (focusTimer !== null) {
        window.clearTimeout(focusTimer);
        focusTimer = null;
      }
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      window.removeEventListener("focus", onWindowFocus);
      input.remove();
    };

    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(files);
    };

    const onChange = () => {
      finish(Array.from(input.files ?? []));
    };

    const onCancel = () => {
      finish([]);
    };

    const onWindowFocus = () => {
      focusTimer = window.setTimeout(() => {
        finish(Array.from(input.files ?? []));
      }, 300);
    };

    input.addEventListener("change", onChange, { once: true });
    input.addEventListener("cancel", onCancel, { once: true });
    window.addEventListener("focus", onWindowFocus, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}
