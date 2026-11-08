plugins {
    id("com.android.application")
}

android {
    namespace = "com.example.ompattachfixture"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.example.ompattachfixture"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
}
