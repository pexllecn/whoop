# Notices

## Trademarks

WHOOP is a trademark of WHOOP, Inc. OpenPulse is an independent project. It is not affiliated with, endorsed by or supported by WHOOP. The name is used only to describe compatibility with a strap the user owns.

## Protocol sources

- **OpenPulse 5.0 specification** (supplied by the strap owner): the AA01 frame layout, CRC16-Modbus header and CRC32 payload checksums, characteristic roles for service `fd4b0001-cce1-4033-93ce-002d5875f58a`, the wake handshake, and the `CLIENT_HELLO` frame. The test vectors in `tests/protocol` verify all of these.
- **[@dofek/whoop-ble](https://github.com/Asherlc/dofek)** (MIT License, © its authors): community reverse-engineering notes. OpenPulse uses facts published there, not code: the alternate service UUIDs, packet types `0x28`/`0x2B`/`0x2F`/`0x33`/`0x34`, command opcodes (`0x03`, `0x3F`, `0x51`, `0x52`, `0x69`, `0x6A`, `0x6C`), the community command parameter bytes, the record field offsets, and the IMU scale factors. Every one of these is labelled `community` / *unverified* in the code and the UI.
- **Bluetooth SIG**: Heart Rate Service 1.0 (Heart Rate Measurement `0x2A37`), Battery Service, Device Information Service.

## Methods cited in the scoring engine

- Task Force of the ESC and NASPE (1996). Heart rate variability: standards of measurement, physiological interpretation and clinical use. *Circulation* 93(5).
- Plews DJ, Laursen PB, Kilding AE, Buchheit M (2012). Heart rate variability in elite triathletes. *Eur J Appl Physiol* 112.
- Karvonen MJ, Kentala E, Mustala O (1957). The effects of training on heart rate. *Ann Med Exp Biol Fenn* 35.
- Banister EW (1991). Modeling elite athletic performance. In: *Physiological Testing of Elite Athletes*.
- Edwards S (1993). *The Heart Rate Monitor Book*.
- Garber CE et al. (2011). ACSM position stand: quantity and quality of exercise. *Med Sci Sports Exerc* 43(7).
- Tanaka H, Monahan KD, Seals DR (2001). Age-predicted maximal heart rate revisited. *J Am Coll Cardiol* 37(1).
- Keytel LR et al. (2005). Prediction of energy expenditure from heart rate monitoring during submaximal exercise. *J Sports Sci* 23(3).
- Mifflin MD, St Jeor ST et al. (1990). A new predictive equation for resting energy expenditure. *Am J Clin Nutr* 51(2).
- Lomb NR (1976); Scargle JD (1982): least-squares spectral analysis of unevenly sampled data.
- Schäfer A, Kratky KW (2008). Estimation of breathing rate from respiratory sinus arrhythmia. *Ann Biomed Eng* 36(3).
- Finch T (2009). Incremental calculation of weighted mean and variance.

OpenPulse's recovery, strain, sleep and stress scores combine these methods with parameters chosen and calibrated for OpenPulse, as documented in the source. They are estimates, not reproductions of any commercial score, and not medical measurements.
