// storage.js — file system downloading, retries, and persistence
import { Filesystem, FileTransfer } from "../utils/index.js";
import { translations } from "../i18n/index.js";
import { currentLang } from "../modules/core.js";

/**
 * Removes temporary .tmp files across all search directories
 */
export async function cleanupTempFiles(fullPath, targetName, directoriesToTry) {
  if (!Filesystem || !targetName) return;
  const tempName = targetName.endsWith(".tmp") ? targetName : `${targetName}.tmp`;
  for (const dir of directoriesToTry) {
    await Filesystem.deleteFile({
      path: fullPath + "/" + tempName,
      directory: dir,
    }).catch(() => {});
  }
}

/**
 * Deletes saved file across directories (e.g. after cancellation)
 */
export async function deleteSavedFile(savedFile, directoriesToTry) {
  if (!Filesystem || !savedFile?.path) return;
  for (const dir of directoriesToTry) {
    await Filesystem.deleteFile({
      path: savedFile.path,
      directory: dir,
    }).catch(() => {});
  }
}

/**
 * Executes a streamed download using Tauri, Capacitor File Transfer, or the
 * legacy Filesystem downloader. Large media is never fetched into a Base64
 * string as a fallback, because that can multiply memory use and crash Android.
 */
export async function saveToStorage({
  actualDownloadUrl,
  fileName,
  fullPath,
  targetFolder,
  downloadHeaders,
  directoriesToTry,
  checkCancelled,
}) {
  let savedFile = null;
  let successfulDir = "EXTERNAL_STORAGE";
  let attempts = 0;

  const isAutoRetry = localStorage.getItem("mori_auto_retry") !== "false";
  const customMaxRetry = parseInt(
    localStorage.getItem("mori_max_retry") || "3",
    10,
  );
  const maxAttempts = isAutoRetry ? customMaxRetry : 1;

  const tauriInvoke =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.invoke;

  // 1. Desktop / Tauri Invocation
  if (tauriInvoke) {
    try {
      const desktopRes = await tauriInvoke("tauri_download_file", {
        url: actualDownloadUrl,
        filename: fileName,
        folder: fullPath || targetFolder || "",
        headers: downloadHeaders || {},
      });
      if (desktopRes && desktopRes.status) {
        savedFile = { path: desktopRes.path, uri: desktopRes.uri };
      }
    } catch (tErr) {
      console.warn("Tauri native download failed:", tErr);
      throw new Error(
        typeof tErr === "string"
          ? tErr
          : tErr?.message || JSON.stringify(tErr),
      );
    }
  }

  // 2. Mobile / Capacitor streaming download. FileTransfer is the preferred
  // plugin for Capacitor 7; Filesystem.downloadFile is retained for older builds.
  const tempFileName = `${fileName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.tmp`;
  const useFileTransfer =
    Boolean(FileTransfer?.downloadFile) &&
    Boolean(Filesystem?.getUri) &&
    Boolean(window.Capacitor?.isNativePlatform?.());

  if (!savedFile && Filesystem) {
    for (const dir of directoriesToTry) {
      if (savedFile) break;
      attempts = 0;

      while (attempts < maxAttempts && !savedFile) {
        if (checkCancelled()) {
          await cleanupTempFiles(fullPath, tempFileName, directoriesToTry);
          return { savedFile: null, successfulDir, cancelled: true };
        }

        attempts++;
        if (attempts > 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        const isBypassSsl =
          localStorage.getItem("mori_bypass_ssl") === "true";
        const isForceIpv4 =
          localStorage.getItem("mori_force_ipv4") === "true";

        try {
          const dlOpts = {
            url: actualDownloadUrl,
            path: `${fullPath}/${tempFileName}`,
            directory: dir,
            progress: true,
            headers: downloadHeaders,
            recursive: true,
          };
          if (isBypassSsl) dlOpts.disableSSLValidation = true;
          if (isForceIpv4) dlOpts.ipv4Only = true;

          let downloadedWithFileTransfer = false;
          if (useFileTransfer && !isBypassSsl && !isForceIpv4) {
            try {
              // FileTransfer writes network chunks directly to disk. getUri()
              // is required because FileTransfer accepts a full native file URI.
              const tempUri = await Filesystem.getUri({
                path: `${fullPath}/${tempFileName}`,
                directory: dir,
              });
              if (!tempUri?.uri) {
                throw new Error(`Could not resolve the temporary file path for ${dir}`);
              }

              await FileTransfer.downloadFile({
                url: actualDownloadUrl,
                path: tempUri.uri,
                progress: true,
                headers: downloadHeaders || {},
                connectTimeout: 30000,
                readTimeout: 120000,
              });
              downloadedWithFileTransfer = true;
            } catch (transferErr) {
              // Safe fallback: Filesystem.downloadFile also streams to disk.
              // Never use CapacitorHttp.get(blob), which buffers the whole media.
              console.warn("FileTransfer failed; trying the legacy streaming downloader:", transferErr);
              await Filesystem.deleteFile({
                path: `${fullPath}/${tempFileName}`,
                directory: dir,
              }).catch(() => {});
            }
          }

          if (!downloadedWithFileTransfer) {
            await Filesystem.downloadFile(dlOpts);
          }

          // Rename .tmp to the actual filename atomically on completion.
          try {
            await Filesystem.rename({
              from: `${fullPath}/${tempFileName}`,
              to: `${fullPath}/${fileName}`,
              directory: dir,
            });
            savedFile = { path: `${fullPath}/${fileName}` };
          } catch (renameErr) {
            // Fallback copy is file-to-file; it does not load the video into JS memory.
            await Filesystem.copy({
              from: `${fullPath}/${tempFileName}`,
              to: `${fullPath}/${fileName}`,
              directory: dir,
            });
            await Filesystem.deleteFile({
              path: `${fullPath}/${tempFileName}`,
              directory: dir,
            }).catch(() => {});
            savedFile = { path: `${fullPath}/${fileName}` };
          }
          successfulDir = dir;
        } catch (dlErr) {
          console.warn(
            `Streaming download attempt ${attempts} on ${dir} failed:`,
            dlErr,
          );
          await Filesystem.deleteFile({
            path: `${fullPath}/${tempFileName}`,
            directory: dir,
          }).catch(() => {});

          // Intentionally do not call CapacitorHttp.get({ responseType: "blob" })
          // here. That fallback materializes the full media response in memory,
          // which is the likely trigger for Android's OutOfMemoryError.
        }
      }
    }
  }

  if (!savedFile) {
    if (checkCancelled()) {
      await cleanupTempFiles(fullPath, tempFileName, directoriesToTry);
      return { savedFile: null, successfulDir, cancelled: true };
    }
    await cleanupTempFiles(fullPath, tempFileName, directoriesToTry);
    throw new Error(
      translations[currentLang]?.["toast-download-failed"] ||
        "Download failed. The streamed download failed; retry on a stable connection.",
    );
  }

  if (checkCancelled()) {
    await deleteSavedFile(savedFile, directoriesToTry);
    return { savedFile: null, successfulDir, cancelled: true };
  }

  return { savedFile, successfulDir, cancelled: false };
}
