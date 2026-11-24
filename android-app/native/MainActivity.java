package com.mdsd.clouddisk;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * 膜登时代 App 主入口：在 Capacitor WebView 上注册原生下载桥，
 * 并给 UA 追加 CloudDiskApp 标记，便于前端识别 App 身份。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.addJavascriptInterface(new DownloadBridge(this, webView), "CloudDisk");
            try {
                String ua = webView.getSettings().getUserAgentString();
                if (ua == null || ua.length() == 0) {
                    ua = android.webkit.WebSettings.getDefaultUserAgent(this);
                }
                if (ua.indexOf("CloudDiskApp") < 0) {
                    webView.getSettings().setUserAgentString(ua + " CloudDiskApp");
                }
            } catch (Throwable ignored) {
            }
        }
    }
}
