/*
 * Adaptive AI Tennis — M5Stack Real-Time 100 Hz Wireless BLE + USB Serial IMU Firmware
 *
 * Designed for ultra-low latency (<10 ms wireless over BLE GATT notifications):
 *  - Advertises as "M5-TENNIS-IMU" immediately on boot (works on battery, zero Wi-Fi needed!)
 *  - Streams 13-byte packed binary IMU packets at 100 Hz over BLE Notify
 *  - Streams compact CSV lines at 100 Hz over USB Serial (115200 baud)
 *  - ZERO full-screen LCD redraws in loop() -> zero 40 ms SPI stalls!
 *  - Button A = Re-Center Aim
 */

#include <M5Unified.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

static const char* BLE_DEVICE_NAME   = "M5-TENNIS-IMU";
static const char* SERVICE_UUID      = "19b10000-e8f2-537e-4f6c-d104768a1214";
static const char* IMU_CHAR_UUID     = "19b10001-e8f2-537e-4f6c-d104768a1214";
static const char* CMD_CHAR_UUID     = "19b10002-e8f2-537e-4f6c-d104768a1214";

static BLEServer* bleServer = nullptr;
static BLECharacteristic* imuChar = nullptr;
static volatile bool bleConnected = false;
static bool lastDrawnBleState = false;
static volatile bool pendingRecenter = false;
static volatile bool remoteRecenterFlash = false;

static unsigned long lastSampleUs = 0;
static unsigned long lastBarDrawMs = 0;
static unsigned long recenterBannerUntilMs = 0;
static float peakBarG = 0.0f;
static float lastLinG = 0.0f;
static float lastGyroDps = 0.0f;
static int lastBarFillW = -1;
static bool bannerActive = false;

class TennisServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    bleConnected = true;
  }
  void onDisconnect(BLEServer* server) override {
    bleConnected = false;
    // Immediately restart advertising so browser can reconnect anytime
    server->getAdvertising()->start();
  }
};

class TennisCmdCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String val = ch->getValue();
    if (val.indexOf("RECENTER") >= 0 || val.indexOf("recenter") >= 0) {
      remoteRecenterFlash = true;
    }
  }
};

static inline int16_t clampI16(float v) {
  if (v > 32767.0f) return 32767;
  if (v < -32768.0f) return -32768;
  return (int16_t)v;
}

static const char* boardNameStr(m5::board_t b) {
  switch (b) {
    case m5::board_t::board_M5Stack: return "M5Stack";
    case m5::board_t::board_M5StackCore2: return "M5Core2";
    case m5::board_t::board_M5StackCoreS3: return "M5CoreS3";
    case m5::board_t::board_M5StickCPlus: return "StickC+";
    case m5::board_t::board_M5StickCPlus2: return "StickC+2";
    case m5::board_t::board_M5Tough: return "M5Tough";
    default: return "M5 ESP32";
  }
}

static const char* imuNameStr(m5::imu_t t) {
  switch (t) {
    case m5::imu_t::imu_mpu6050: return "MPU6050";
    case m5::imu_t::imu_mpu6886: return "MPU6886";
    case m5::imu_t::imu_mpu9250: return "MPU9250";
    case m5::imu_t::imu_sh200q: return "SH200Q";
    case m5::imu_t::imu_bmi270: return "BMI270";
    default: return "IMU";
  }
}

static void drawStaticScreen() {
  auto& d = M5.Display;
  int w = d.width();
  int h = d.height();
  if (w <= 0 || h <= 0) return;

  d.fillScreen(TFT_BLACK);
  d.fillRect(0, 0, w, 30, TFT_NAVY);
  d.setTextColor(TFT_WHITE, TFT_NAVY);
  d.setTextSize(w >= 240 ? 2 : 1);
  d.setCursor(8, 7);
  d.print("TENNIS IMU");

  d.setTextColor(TFT_CYAN, TFT_BLACK);
  d.setTextSize(1);
  d.setCursor(8, 38);
  d.printf("%s | %s | BLE: M5-TENNIS-IMU", boardNameStr(M5.getBoard()), imuNameStr(M5.Imu.getType()));

  d.drawRect(8, 62, w - 16, 26, TFT_DARKGREY);

  d.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
  d.setTextSize(1);
  d.setCursor(8, h - 22);
  d.print("BtnA: Re-Center   |   100Hz Real-Time");
}

static void drawBleBadge(bool connected) {
  auto& d = M5.Display;
  int w = d.width();
  if (w <= 0) return;
  uint16_t bg = connected ? TFT_DARKGREEN : TFT_DARKGREY;
  d.fillRect(w - 92, 4, 86, 22, bg);
  d.setTextColor(TFT_WHITE, bg);
  d.setTextSize(1);
  d.setCursor(w - 86, 11);
  d.print(connected ? "BLE LIVE!" : "BLE READY");
}

static void drawLightweightBar(unsigned long now) {
  auto& d = M5.Display;
  int w = d.width();
  int h = d.height();
  if (w <= 0 || h <= 0) return;

  if (lastLinG > peakBarG) peakBarG = lastLinG;
  else peakBarG *= 0.85f;

  int innerW = w - 18;
  int fillW = (int)(fminf(1.0f, peakBarG / 3.5f) * innerW);

  // Only redraw delta pixels — takes <1 ms!
  if (fillW != lastBarFillW) {
    uint16_t col = (peakBarG > 1.8f) ? TFT_RED : (peakBarG > 0.8f ? TFT_YELLOW : TFT_GREEN);
    if (fillW > 0) d.fillRect(9, 63, fillW, 24, col);
    if (fillW < innerW) d.fillRect(9 + fillW, 63, innerW - fillW, 24, TFT_BLACK);
    lastBarFillW = fillW;
  }

  // Tiny banner toggle only on state edge
  bool shouldShowBanner = now < recenterBannerUntilMs;
  if (shouldShowBanner != bannerActive) {
    bannerActive = shouldShowBanner;
    if (bannerActive) {
      d.fillRect(8, h - 56, w - 16, 26, TFT_BLUE);
      d.setTextColor(TFT_WHITE, TFT_BLUE);
      d.setTextSize(2);
      d.setCursor(20, h - 50);
      d.print("RE-CENTERED");
    } else {
      d.fillRect(8, h - 56, w - 16, 26, TFT_BLACK);
    }
  }
}

void setup() {
  auto cfg = M5.config();
  cfg.internal_imu = true;
  M5.begin(cfg);

  Serial.begin(115200);

  if (M5.Display.width() > 0) {
    if (M5.Display.width() < M5.Display.height()) {
      M5.Display.setRotation(1);
    }
    M5.Display.setBrightness(150);
    drawStaticScreen();
    drawBleBadge(false);
  }

  // Initialize BLE GATT server for instant wireless 100 Hz streaming
  BLEDevice::init(BLE_DEVICE_NAME);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new TennisServerCallbacks());

  BLEService* service = bleServer->createService(SERVICE_UUID);
  imuChar = service->createCharacteristic(
    IMU_CHAR_UUID,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  imuChar->addDescriptor(new BLE2902());

  BLECharacteristic* cmdChar = service->createCharacteristic(
    CMD_CHAR_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  cmdChar->setCallbacks(new TennisCmdCallbacks());

  service->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  // Request 7.5ms–15ms BLE connection interval for real-time low latency on macOS/Chrome
  adv->setMinPreferred(0x06);
  adv->setMaxPreferred(0x0C);
  BLEDevice::startAdvertising();

  Serial.printf("{\"type\":\"info\",\"board\":\"%s\",\"imu\":\"%s\",\"ble\":\"%s\"}\n",
                boardNameStr(M5.getBoard()), imuNameStr(M5.Imu.getType()), BLE_DEVICE_NAME);

  lastSampleUs = micros();
}

void loop() {
  M5.update();
  unsigned long nowMs = millis();

  if (M5.BtnA.wasPressed()) {
    pendingRecenter = true;
    recenterBannerUntilMs = nowMs + 700;
  }
  if (remoteRecenterFlash) {
    remoteRecenterFlash = false;
    recenterBannerUntilMs = nowMs + 700;
  }

  // Handle simple serial commands (non-blocking)
  while (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "RECENTER") {
      recenterBannerUntilMs = nowMs + 700;
    } else if (cmd == "INFO") {
      Serial.printf("{\"type\":\"info\",\"board\":\"%s\",\"imu\":\"%s\",\"ble\":\"%s\"}\n",
                    boardNameStr(M5.getBoard()), imuNameStr(M5.Imu.getType()), BLE_DEVICE_NAME);
    }
  }

  // Exact 100 Hz (10,000 us) real-time IMU loop
  unsigned long nowUs = micros();
  if (nowUs - lastSampleUs >= 10000UL) {
    lastSampleUs = nowUs;

    if (M5.Imu.isEnabled() && M5.Imu.update()) {
      auto data = M5.Imu.getImuData();
      float ax = data.accel.x;
      float ay = data.accel.y;
      float az = data.accel.z;
      float gx = data.gyro.x;
      float gy = data.gyro.y;
      float gz = data.gyro.z;

      float magG = sqrtf(ax * ax + ay * ay + az * az);
      lastLinG = fabsf(magG - 1.0f);
      lastGyroDps = sqrtf(gx * gx + gy * gy + gz * gz);

      uint8_t flags = pendingRecenter ? 1 : 0;
      pendingRecenter = false;

      // 1. Wireless BLE binary notify (13 bytes, <10 ms latency)
      if (bleConnected && imuChar != nullptr) {
        uint8_t pkt[13];
        int16_t vals[6] = {
          clampI16(ax * 1000.0f),
          clampI16(ay * 1000.0f),
          clampI16(az * 1000.0f),
          clampI16(gx * 10.0f),
          clampI16(gy * 10.0f),
          clampI16(gz * 10.0f)
        };
        memcpy(pkt, vals, 12);
        pkt[12] = flags;
        imuChar->setValue(pkt, 13);
        imuChar->notify();
      }

      // 2. Compact CSV over USB Serial (ultra-fast, no JSON formatting overhead)
      // Format: I,ax,ay,az,gx,gy,gz,flags
      Serial.printf("I,%.3f,%.3f,%.3f,%.1f,%.1f,%.1f,%u\n", ax, ay, az, gx, gy, gz, flags);
    }
  }

  // Only update BLE status badge when connection state actually flips
  bool curBle = bleConnected;
  if (curBle != lastDrawnBleState) {
    lastDrawnBleState = curBle;
    drawBleBadge(curBle);
  }

  // Ultra-light bar redraw at 8 Hz (dirty rect only, <1 ms)
  if (nowMs - lastBarDrawMs >= 125) {
    lastBarDrawMs = nowMs;
    drawLightweightBar(nowMs);
  }
}
