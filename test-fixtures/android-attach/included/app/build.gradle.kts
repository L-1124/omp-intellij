plugins {
    id("com.android.application")
}

android {
    namespace = "com.example.ompattachincluded"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.example.ompattachincluded"
        minSdk = 26
        targetSdk = 37
        versionCode = 2
        versionName = "2.0.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
}
