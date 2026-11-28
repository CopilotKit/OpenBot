plugins {
    id("com.android.application")
}

android {
    namespace = "ai.openbot.shell"
    compileSdk = 36

    defaultConfig {
        applicationId = "ai.openbot.shell"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // The only server a release build knows. Tests point the debug and releaseTest builds
        // elsewhere with an intent extra (TEST_OVERRIDES); a release build cannot be pointed anywhere.
        buildConfigField("String", "BASE_URL", "\"https://my.open.bot\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        getByName("debug") {
            // Base URL, diagnostics and test name from intent extras; the debug-only hooks live in
            // src/debug.
            buildConfigField("boolean", "TEST_OVERRIDES", "true")
        }
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("boolean", "TEST_OVERRIDES", "false")
        }
        // Release settings (minified and shrunk by R8 like release, no debug hooks, not debuggable),
        // with four differences, all for the tests: its own application id (so it installs beside the
        // debug build that drives it), the debug signing key, and TEST_OVERRIDES, which lets an intent
        // extra set the base URL, turn diagnostics on and name the test. See README.md.
        create("releaseTest") {
            initWith(getByName("release"))
            applicationIdSuffix = ".releasetest"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
            buildConfigField("boolean", "TEST_OVERRIDES", "true")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
        checkReleaseBuilds = true
        textReport = true
        htmlReport = true
        xmlReport = true
    }

    testOptions {
        animationsDisabled = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.13.0")
    implementation("androidx.browser:browser:1.8.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
