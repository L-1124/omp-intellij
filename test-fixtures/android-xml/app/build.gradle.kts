plugins {
    id("com.android.application")
}

android {
    namespace = "com.example.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.example.app"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "android.test.InstrumentationTestRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets {
        getByName("main") {
            res.srcDir("custom-res")
            manifest.srcFile("config/manifest-main.xml")
        }
    }
}

dependencies {
    implementation(project(":lib"))
    implementation(files("libs/no-sources.jar"))
}
