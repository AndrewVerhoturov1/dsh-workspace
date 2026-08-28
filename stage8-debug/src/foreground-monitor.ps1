param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][long]$TargetHwnd,
  [int]$DurationMs = 120000
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class DshForegroundMonitor {
  const uint EVENT_SYSTEM_FOREGROUND=0x0003, WINEVENT_OUTOFCONTEXT=0, GA_ROOTOWNER=3, WM_QUIT=0x0012;
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  delegate void WinEventProc(IntPtr hook,uint evt,IntPtr hwnd,int idObject,int idChild,uint thread,uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr mod,WinEventProc proc,uint pid,uint tid,uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg,IntPtr hwnd,uint min,uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid,uint msg,UIntPtr w,IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
  static WinEventProc callback; static long targetHwnd; static int targetPid;
  static string Json(string value) { return "\""+value.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r","\\r").Replace("\n","\\n")+"\""; }
  static void OnEvent(IntPtr hook,uint evt,IntPtr hwnd,int idObject,int idChild,uint thread,uint time) {
    if(hwnd==IntPtr.Zero)return; uint pid; GetWindowThreadProcessId(hwnd,out pid); var root=GetAncestor(hwnd,GA_ROOTOWNER); var text=new StringBuilder(512); GetWindowText(hwnd,text,text.Capacity);
    var matched=(root.ToInt64()==targetHwnd || hwnd.ToInt64()==targetHwnd);
    Console.WriteLine("{\"event\":\"foreground\",\"timestamp\":\""+DateTime.UtcNow.ToString("O")+"\",\"hwnd\":"+hwnd.ToInt64()+",\"rootHwnd\":"+root.ToInt64()+",\"pid\":"+pid+",\"title\":"+Json(text.ToString())+",\"targetMatched\":"+matched.ToString().ToLowerInvariant()+"}"); Console.Out.Flush();
  }
  public static void Run(int pid,long hwnd,int duration) {
    targetPid=pid; targetHwnd=hwnd; callback=OnEvent;
    var hook=SetWinEventHook(EVENT_SYSTEM_FOREGROUND,EVENT_SYSTEM_FOREGROUND,IntPtr.Zero,callback,0,0,WINEVENT_OUTOFCONTEXT);
    if(hook==IntPtr.Zero) throw new InvalidOperationException("SetWinEventHook failed");
    var tid=GetCurrentThreadId(); Console.WriteLine("{\"event\":\"ready\"}"); Console.Out.Flush();
    var stopper=new Thread(()=>{Thread.Sleep(Math.Max(1,duration)); PostThreadMessage(tid,WM_QUIT,UIntPtr.Zero,IntPtr.Zero);}); stopper.IsBackground=true; stopper.Start();
    try { MSG msg; while(GetMessage(out msg,IntPtr.Zero,0,0)>0){TranslateMessage(ref msg);DispatchMessage(ref msg);} } finally { UnhookWinEvent(hook); }
  }
}
"@
[DshForegroundMonitor]::Run($TargetPid,$TargetHwnd,$DurationMs)
