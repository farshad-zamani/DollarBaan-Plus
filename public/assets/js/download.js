import { IS_LOCAL, localDownload, serverProfile } from './api.js';

function nativePlugins() {
    const capacitor = window.Capacitor;
    return capacitor && capacitor.isNativePlatform && capacitor.isNativePlatform() ? capacitor.Plugins : null;
}

/** Saves a generated file: share sheet on Android, a normal download elsewhere. */
export async function saveFile({ filename, type, body }) {
    const plugins = nativePlugins();
    if (plugins && plugins.Filesystem && plugins.Share) {
        const written = await plugins.Filesystem.writeFile({ path: filename, data: body, directory: 'CACHE', encoding: 'utf8' });
        try {
            await plugins.Share.share({ title: filename, files: [written.uri], dialogTitle: 'ذخیره یا ارسال فایل' });
        } catch (error) {
            // Closing the share sheet is not an error.
            if (!/cancel/i.test(String(error && error.message))) throw error;
        } finally {
            // The export is plain text: do not leave a copy of it in the app's cache.
            plugins.Filesystem.deleteFile({ path: filename, directory: 'CACHE' }).catch(() => {});
        }
        return;
    }
    const url = URL.createObjectURL(new Blob([body], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Downloads an export endpoint (e.g. "/api/export.csv") in either mode. */
export async function downloadExport(path) {
    if (!IS_LOCAL) {
        const link = document.createElement('a');
        const profile = /[?&]profile=/.test(path) ? '' : serverProfile();
        link.href = profile ? `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}` : path;
        link.download = '';
        document.body.append(link);
        link.click();
        link.remove();
        return;
    }
    await saveFile(await localDownload(path));
}
