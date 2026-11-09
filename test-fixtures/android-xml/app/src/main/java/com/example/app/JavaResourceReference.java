package com.example.app;

import static com.example.app.R.string.app_name;

public class JavaResourceReference {
    public int staticImportUsage() {
        return app_name;
    }

    public int qualifiedUsage() {
        return com.example.app.R.string.app_name;
    }
}
