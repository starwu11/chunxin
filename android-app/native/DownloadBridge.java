package com.mdsd.clouddisk;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 膜登时代 App 原生下载桥。
 * 前端通过 window.CloudDisk.download(url, id, name) 调用；
 * 本类用 WebView 的 Cookie（含 HttpOnly 的登录态）发起真实下载，
 * 保存系统「下载」目录，并通过 evaluateJavascript 回传进度与结果。
 */
public class DownloadBridge {
    private final Context context;
    private final WebView webView;
    private final ExecutorService executor = Executors.newFixedThreadPool(2);

    public DownloadBridge(Context context, WebView webView) {
        this.context = context.getApplicationContext();
        this.webView = webView;
    }

    @JavascriptInterface
    public String download(String url, String id, String name) {
        if (url == null || url.length() == 0) return "error:empty-url";
        final String safeId = (id == null || id.length() == 0) ? "0" : id;
        final String safeName = (name == null || name.length() == 0) ? "download" : name;
        executor.execute(new Runnable() {
            @Override
            public void run() {
                doDownload(url, safeId, safeName);
            }
        });
        return "ok:queued";
    }

    private void callJs(final String js) {
        webView.post(new Runnable() {
            @Override
            public void run() {
                try {
                    webView.evaluateJavascript(js, null);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    private void reportProgress(String id, long downloaded, long total) {
        callJs("window.onAppDownloadProgress && window.onAppDownloadProgress("
                + id + "," + downloaded + "," + total + ")");
    }

    private void reportComplete(String id, boolean success) {
        callJs("window.onAppDownloadComplete && window.onAppDownloadComplete("
                + id + "," + (success ? "true" : "false") + ")");
    }

    private void doDownload(String url, String id, String name) {
        HttpURLConnection conn = null;
        InputStream is = null;
        OutputStream os = null;
        try {
            URL target = new URL(url);
            conn = (HttpURLConnection) target.openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setRequestMethod("GET");

            // 透传 WebView 的 Cookie（登录态 cd_session 为 HttpOnly，只能这样拿）
            try {
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null && cookies.length() > 0) {
                    conn.setRequestProperty("Cookie", cookies);
                }
            } catch (Throwable ignored) {
            }

            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                reportComplete(id, false);
                return;
            }

            String fileName = resolveFileName(conn, name);
            long total = conn.getContentLengthLong();
            is = conn.getInputStream();
            os = openOutput(fileName);

            byte[] buf = new byte[16384];
            long downloaded = 0;
            long lastReport = 0;
            int read;
            while ((read = is.read(buf)) != -1) {
                os.write(buf, 0, read);
                downloaded += read;
                long now = System.currentTimeMillis();
                if (now - lastReport >= 300) {
                    lastReport = now;
                    reportProgress(id, downloaded, total > 0 ? total : downloaded);
                }
            }
            os.flush();
            reportProgress(id, downloaded, total > 0 ? total : downloaded);
            reportComplete(id, true);
        } catch (Throwable e) {
            reportComplete(id, false);
        } finally {
            closeQuietly(is);
            closeQuietly(os);
            if (conn != null) conn.disconnect();
        }
    }

    private String resolveFileName(HttpURLConnection conn, String fallback) {
        String cd = conn.getHeaderField("Content-Disposition");
        if (cd != null) {
            int idx = cd.indexOf("filename*=UTF-8''");
            if (idx >= 0) {
                String val = cd.substring(idx + "filename*=UTF-8''".length()).trim();
                int semi = val.indexOf(';');
                if (semi >= 0) val = val.substring(0, semi);
                try {
                    return URLDecoder.decode(val, "UTF-8");
                } catch (Throwable e) {
                    return val;
                }
            }
            idx = cd.indexOf("filename=\"");
            if (idx >= 0) {
                String val = cd.substring(idx + "filename=\"".length());
                int end = val.indexOf('"');
                if (end >= 0) val = val.substring(0, end);
                return val;
            }
        }
        return safeName(fallback);
    }

    private String safeName(String name) {
        return name == null ? "download" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    private OutputStream openOutput(String fileName) throws Exception {
        String name = safeName(fileName);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, guessMime(name));
            values.put(MediaStore.Downloads.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + File.separator + "膜登时代");
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new Exception("create download entry failed");
            return resolver.openOutputStream(uri);
        } else {
            File dir = new File(Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS), "膜登时代");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("mkdir failed");
            File out = new File(dir, name);
            return new FileOutputStream(out);
        }
    }

    private String guessMime(String name) {
        String lower = name.toLowerCase();
        if (lower.endsWith(".zip")) return "application/zip";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".pdf")) return "application/pdf";
        if (lower.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    private void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (Throwable ignored) {
        }
    }
}
