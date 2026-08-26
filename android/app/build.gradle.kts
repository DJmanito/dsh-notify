plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release 签名:keystore/ 目录不入 git(开源安全);缺失 signing.properties 时 release 构建为未签名包
val signingPropsFile = rootProject.file("keystore/signing.properties")
val signingProps: Map<String, String> = if (signingPropsFile.exists()) {
    signingPropsFile.readLines().associate { line ->
        val i = line.indexOf('=')
        if (i > 0) line.substring(0, i) to line.substring(i + 1).trim() else line to ""
    }
} else emptyMap()

android {
    namespace = "com.dsh.notify"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
        targetSdk = 35
        // App 身份:applicationId(代码包 namespace 为 com.dsh.notify)
        applicationId = "com.dsh.remotenotify"
        versionCode = 1
        versionName = "1.0-notify"
    }

    signingConfigs {
        if (signingProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file("keystore/${signingProps["storeFile"]}")
                storePassword = signingProps["storePassword"]
                keyAlias = signingProps["keyAlias"]
                keyPassword = signingProps["keyPassword"]
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    testImplementation("junit:junit:4.13.2")
}


