import { webFrame } from "electron";

/**
 * Sandboxed Preload for the Inner Flow WebContentsView.
 *
 * CRITICAL BOUNDARY:
 * - Strictly NO-OP on accounts.google.com or any third-party auth domain so
 *   interactive Google Sign-In / 2FA / Passkey runs in an untouched Chromium context.
 * - On flow.google.com (or an explicit local E2E mock origin), installs the
 *   grecaptcha.enterprise.execute anti-hijack guard and serialized captcha mint
 *   queue in MAIN world before page scripts run — with zero chrome-extension://
 *   script tags in the DOM.
 */
(function bootstrapFlowPreload() {
  const mockArg = process.argv.find((a) => a.startsWith("--flowboard-mock-flow-origin="));
  const mockOrigin = mockArg ? mockArg.split("=", 2)[1] : "";

  const origin = window.location.origin;
  const host = window.location.hostname;

  const isFlowTarget =
    host === "flow.google.com" ||
    host === "labs.google" ||
    (Boolean(mockOrigin) && origin === mockOrigin);

  if (!isFlowTarget) {
    return;
  }

  const MAIN_WORLD_SCRIPT = `
(function () {
  if (globalThis.__flowboardMainBootstrapped) return;
  Object.defineProperty(globalThis, '__flowboardMainBootstrapped', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
  let realExecute = null;

  const origDefineProperty = Object.defineProperty;
  Object.defineProperty = function (obj, prop, descriptor) {
    if (prop === 'execute' && descriptor && (descriptor.value || descriptor.get)) {
      let fn = null;
      try {
        fn = descriptor.value || (typeof descriptor.get === 'function' ? descriptor.get() : null);
      } catch (_e) {}
      if (typeof fn === 'function') {
        const src = Function.prototype.toString.call(fn);
        if (src.includes('extension_hijack_detected')) {
          return obj;
        }
        if (!realExecute) {
          realExecute = fn;
        } else if (fn !== realExecute) {
          return obj;
        }
      }
    }
    return origDefineProperty.call(this, obj, prop, descriptor);
  };

  function trapExecute(enterpriseObj) {
    if (!enterpriseObj || typeof enterpriseObj !== 'object') return;
    let target = enterpriseObj.execute;
    if (typeof target === 'function' && !Function.prototype.toString.call(target).includes('extension_hijack_detected')) {
      realExecute = target;
    }
    try {
      origDefineProperty.call(Object, enterpriseObj, 'execute', {
        configurable: true,
        enumerable: true,
        get() {
          return realExecute || target;
        },
        set(fn) {
          if (typeof fn === 'function') {
            const src = Function.prototype.toString.call(fn);
            if (src.includes('extension_hijack_detected')) {
              return;
            }
            if (!realExecute) {
              realExecute = fn;
              target = fn;
            }
          }
        },
      });
    } catch (_e) {}
  }

  function trapEnterprise(grecaptchaObj) {
    if (!grecaptchaObj || typeof grecaptchaObj !== 'object') return;
    let target = grecaptchaObj.enterprise;
    if (target) trapExecute(target);
    try {
      origDefineProperty.call(Object, grecaptchaObj, 'enterprise', {
        configurable: true,
        enumerable: true,
        get() {
          return target;
        },
        set(val) {
          target = val;
          if (val) trapExecute(val);
        },
      });
    } catch (_e) {}
  }

  let currentGrecaptcha = window.grecaptcha;
  if (currentGrecaptcha) trapEnterprise(currentGrecaptcha);

  try {
    origDefineProperty.call(Object, window, 'grecaptcha', {
      configurable: true,
      enumerable: true,
      get() {
        return currentGrecaptcha;
      },
      set(val) {
        currentGrecaptcha = val;
        if (val) trapEnterprise(val);
      },
    });
  } catch (_e) {}

  function waitForGrecaptcha(timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.grecaptcha && window.grecaptcha.enterprise && typeof window.grecaptcha.enterprise.execute === 'function') {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('grecaptcha not available'));
          return;
        }
        setTimeout(check, 150);
      };
      check();
    });
  }

  let captchaMintTail = Promise.resolve();

  async function mintCaptcha(pageAction) {
    const previous = captchaMintTail.catch(() => {});
    let release;
    captchaMintTail = new Promise((r) => { release = r; });
    await previous;
    try {
      await waitForGrecaptcha(22000);
      const token = await window.grecaptcha.enterprise.execute(SITE_KEY, {
        action: pageAction,
      });
      return { token };
    } catch (err) {
      return { error: (err && err.message) ? err.message : String(err) };
    } finally {
      release();
    }
  }

  origDefineProperty.call(Object, globalThis, '__flowboardMintCaptcha', {
    value: mintCaptcha,
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
`;

  void webFrame.executeJavaScript(MAIN_WORLD_SCRIPT);
})();
