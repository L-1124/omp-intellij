package org.omp.intellij.android;

import java.util.regex.Pattern;

final class AndroidFolders {
    private static final Pattern VALUES = Pattern.compile("values"
            + "(?:-mcc[0-9]{3})?(?:-mnc[0-9]{1,3})?"
            + "(?:-(?:[a-z]{2,3}(?:-r(?:[A-Z]{2}|[0-9]{3}))?|b\\+[A-Za-z0-9]+(?:\\+[A-Za-z0-9]+)*))?"
            + "(?:-(?:neuter|feminine|masculine))?(?:-(?:ldltr|ldrtl))?"
            + "(?:-sw[1-9][0-9]*dp)?(?:-w[1-9][0-9]*dp)?(?:-h[1-9][0-9]*dp)?"
            + "(?:-(?:small|normal|large|xlarge))?(?:-(?:long|notlong))?(?:-(?:round|notround))?"
            + "(?:-(?:widecg|nowidecg))?(?:-(?:highdr|lowdr))?(?:-(?:port|land|square))?"
            + "(?:-(?:car|desk|television|appliance|watch|vrheadset))?(?:-(?:night|notnight))?"
            + "(?:-(?:ldpi|mdpi|tvdpi|hdpi|xhdpi|xxhdpi|xxxhdpi|nodpi|anydpi|[1-9][0-9]*dpi))?"
            + "(?:-(?:notouch|finger|stylus))?(?:-(?:keysexposed|keyshidden|keyssoft))?"
            + "(?:-(?:nokeys|qwerty|12key))?(?:-(?:navexposed|navhidden))?"
            + "(?:-(?:nonav|dpad|trackball|wheel))?(?:-[1-9][0-9]*x[1-9][0-9]*)?(?:-v[1-9][0-9]*)?");

    private AndroidFolders() {
    }

    static boolean isValues(String name) {
        return VALUES.matcher(name).matches();
    }
}
