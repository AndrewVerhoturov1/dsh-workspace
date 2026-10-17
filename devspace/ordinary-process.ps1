param([int]$OwnerPid)
$ErrorActionPreference='Stop'
# Read-only observation; this process never launches, assigns, or kills tool processes.
# Microsoft documents SystemProcessInformation's PID/parent layout and warns that it
# can change. The x64 CreateTime slot (inside Reserved1) is therefore checked against
# documented GetProcessTimes for BOTH this observer and its owning Node process.
# https://learn.microsoft.com/windows/win32/api/winternl/nf-winternl-ntquerysysteminformation
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class OrdinaryCensus {
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int Query(int kind,IntPtr data,int size,out int needed);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module,string name);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process,out long birth,out long exit,out long kernel,out long user);
  public sealed class Row { public long pid; public long parent; public string birth; }
  static readonly Query query=Marshal.GetDelegateForFunctionPointer<Query>(GetProcAddress(GetModuleHandle("ntdll.dll"),"NtQuerySystemInformation"));
  public static Task<string> ReadControl() { return Task.Run(()=>Console.In.ReadLine()); }
  public static Row[] Snapshot(int owner) {
    if(IntPtr.Size!=8 || Environment.OSVersion.Platform!=PlatformID.Win32NT || Environment.OSVersion.Version.Major!=10)throw new Exception("CENSUS_LAYOUT_UNAVAILABLE");
    int size=65536;
    for(int attempt=0;attempt<8;attempt++) {
      if(size>16777216)throw new Exception("CENSUS_SIZE_UNAVAILABLE");
      IntPtr buffer=Marshal.AllocHGlobal(size);
      try {
        int needed,status=query(5,buffer,size,out needed);
        if(status==unchecked((int)0xc0000004)) {size=Math.Max(size*2,needed+65536);continue;}
        if(status!=0 || needed<104 || needed>size)throw new Exception("CENSUS_QUERY_UNAVAILABLE");
        var rows=new List<Row>(); var identities=new HashSet<long>(); int offset=0;
        while(true) {
          if(offset<0 || offset>needed-104 || rows.Count>=65536)throw new Exception("CENSUS_LAYOUT_UNAVAILABLE");
          IntPtr current=IntPtr.Add(buffer,offset);
          int next=Marshal.ReadInt32(current,0);
          long birth=Marshal.ReadInt64(current,32),pid=Marshal.ReadInt64(current,80),parent=Marshal.ReadInt64(current,88);
          if(pid<0 || pid>uint.MaxValue || parent<0 || parent>uint.MaxValue || birth<0 || (pid!=0 && birth==0) || !identities.Add(pid))throw new Exception("CENSUS_IDENTITY_UNAVAILABLE");
          rows.Add(new Row{pid=pid,parent=parent,birth=birth.ToString(System.Globalization.CultureInfo.InvariantCulture)});
          if(next==0)break;
          if(next<104 || next%8!=0 || next>needed-offset)throw new Exception("CENSUS_LAYOUT_UNAVAILABLE");
          offset+=next;
        }
        Row self=rows.Find(row=>row.pid==GetCurrentProcessId()),parentRow=rows.Find(row=>row.pid==owner);
        long created,exit,kernel,user;
        if(self==null || parentRow==null || self.parent!=owner || !GetProcessTimes(GetCurrentProcess(),out created,out exit,out kernel,out user) || self.birth!=created.ToString())throw new Exception("CENSUS_SELF_UNAVAILABLE");
        IntPtr handle=OpenProcess(0x1000,false,owner);
        if(handle==IntPtr.Zero)throw new Exception("CENSUS_OWNER_UNAVAILABLE");
        try { if(!GetProcessTimes(handle,out created,out exit,out kernel,out user) || parentRow.birth!=created.ToString())throw new Exception("CENSUS_OWNER_UNAVAILABLE"); }
        finally { CloseHandle(handle); }
        return rows.ToArray();
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    throw new Exception("CENSUS_QUERY_UNAVAILABLE");
  }
}
'@
try {
  $control=[OrdinaryCensus]::ReadControl()
  $sequence=0
  $ack=0
  while($true) {
    while($control.IsCompleted) {
      $line=$control.GetAwaiter().GetResult()
      if($null -eq $line){exit 0}
      $request=$line|ConvertFrom-Json
      $ticket=[long]$request.ticket
      if($ticket -le $ack -or $ticket -gt 9007199254740991){throw 'CENSUS_TICKET_UNAVAILABLE'}
      $ack=$ticket
      $control=[OrdinaryCensus]::ReadControl()
    }
    $rows=[OrdinaryCensus]::Snapshot($OwnerPid)
    $sequence++
    [Console]::Out.WriteLine((@{version=1;sequence=$sequence;ack=$ack;rows=$rows}|ConvertTo-Json -Depth 4 -Compress))
    [Console]::Out.Flush()
    [Threading.Thread]::Sleep(100)
  }
} catch {
  try { [Console]::Out.WriteLine('{"version":1,"error":"NATIVE_CENSUS_UNAVAILABLE"}') } catch {}
  exit 1
}
