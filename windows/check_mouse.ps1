# Does Windows have a mouse that DirectInput (and so the 2002 EQ client) can use?
# Pass: SM_MOUSEPRESENT=1 and "SysMouse: CreateDevice hr=0x00000000 (ok)".
# Fail (no mouse attached, e.g. a VNC-only PC): SM_MOUSEPRESENT=0, hr=0x80040154 -> client crashes on Play.
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class DI {
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string n);
  [DllImport("dinput8.dll")] public static extern int DirectInput8Create(IntPtr hinst, int ver, ref Guid riid, out IntPtr ppv, IntPtr outer);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int CreateDeviceFn(IntPtr self, ref Guid g, out IntPtr dev, IntPtr outer);
  public static string Test(Guid dev) {
    Guid iid = new Guid("BF798031-483A-4DA2-AA99-5D64ED369700"); // IID_IDirectInput8W
    IntPtr di; int hr = DirectInput8Create(GetModuleHandle(null), 0x0800, ref iid, out di, IntPtr.Zero);
    if (hr != 0) return "DirectInput8Create hr=0x" + hr.ToString("X8");
    IntPtr vt = Marshal.ReadIntPtr(di); IntPtr fn = Marshal.ReadIntPtr(vt, 3 * IntPtr.Size);
    var cd = (CreateDeviceFn)Marshal.GetDelegateForFunctionPointer(fn, typeof(CreateDeviceFn));
    IntPtr d; hr = cd(di, ref dev, out d, IntPtr.Zero);
    return "CreateDevice hr=0x" + hr.ToString("X8") + (d == IntPtr.Zero ? " (null)" : " (ok)");
  }
}
"@
"SM_MOUSEPRESENT=" + [DI]::GetSystemMetrics(19) + "  SM_CMOUSEBUTTONS=" + [DI]::GetSystemMetrics(43)
"SysMouse:    " + [DI]::Test([Guid]"6F1D2B60-D5A0-11CF-BFC7-444553540000")
"SysKeyboard: " + [DI]::Test([Guid]"6F1D2B61-D5A0-11CF-BFC7-444553540000")
