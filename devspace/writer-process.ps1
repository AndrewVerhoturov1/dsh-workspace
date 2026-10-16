param([switch]$Gate, [string]$SpecFile)
$ErrorActionPreference = 'Stop'
if ($Gate) {
  $spec = Get-Content -LiteralPath $SpecFile -Raw -Encoding utf8 | ConvertFrom-Json
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $spec.shell
  $start.WorkingDirectory = $spec.cwd
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in $spec.args) { $start.ArgumentList.Add([string]$argument) }
  if ($spec.stdin) { $start.RedirectStandardInput = $true }
  $child = [System.Diagnostics.Process]::Start($start)
  $output = $child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardError())
  $errors = $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  if ($spec.stdin) { $child.StandardInput.Write([string]$spec.command); $child.StandardInput.Close() }
  $child.WaitForExit()
  [System.Threading.Tasks.Task]::WhenAll([System.Threading.Tasks.Task[]]@($output,$errors)).GetAwaiter().GetResult()
  exit $child.ExitCode
}

# The fixed gate is suspended until it belongs to a non-breakaway Job Object.
# Its Bash and every descendant inherit that job, including detached children.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PostmanWriterJob {
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFO {
    public int cb; public string reserved, desktop, title;
    public int x,y,xSize,ySize,xCount,yCount,fill,flags;
    public short show,reserved2; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMIT {
    public long processTime,jobTime; public uint flags;
    public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMIT {
    public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ACCOUNTING {
    public long a,b,c,d; public uint faults,total,active,terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED_LIMIT value,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNTING value,int size,IntPtr returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] public static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  public static IntPtr Start(string exe,string command,string cwd,out IntPtr process) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
    PROCESS_INFORMATION child=new PROCESS_INFORMATION();
    try {
      var limit=new EXTENDED_LIMIT(); limit.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no BREAKAWAY
      Check(SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(limit)));
      var startup=new STARTUPINFO(); startup.cb=Marshal.SizeOf(startup); startup.flags=0x100;
      startup.input=GetStdHandle(-10); startup.output=GetStdHandle(-12); startup.error=GetStdHandle(-12);
      Check(SetHandleInformation(startup.input,1,1)); Check(SetHandleInformation(startup.error,1,1));
      Check(CreateProcess(exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref startup,out child));
      Check(AssignProcessToJobObject(job,child.process));
      if(ResumeThread(child.thread)==0xffffffff) throw new System.ComponentModel.Win32Exception();
      process=child.process; CloseHandle(child.thread); return job;
    } catch { if(child.process!=IntPtr.Zero) { TerminateProcess(child.process,1); CloseHandle(child.process); }
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread); CloseHandle(job); throw; }
  }
  public static uint Active(IntPtr job) { ACCOUNTING value; Check(QueryInformationJobObject(job,1,out value,Marshal.SizeOf<ACCOUNTING>(),IntPtr.Zero)); return value.active; }
  public static uint ExitCode(IntPtr process) { uint value; Check(GetExitCodeProcess(process,out value)); return value; }
}
'@
$job = [IntPtr]::Zero
$handle = [IntPtr]::Zero
$file = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'postman-writer-' + [guid]::NewGuid().ToString() + '.json')
try {
  $spec = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if (!$spec.shell -or !$spec.cwd -or !($spec.timeout -gt 0) -or $spec.timeout -gt 300) { throw 'Invalid native writer spec' }
  $spec | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $file -Encoding utf8 -NoNewline
  $exe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $quote = { param($value) '"' + $value.Replace('"','\"') + '"' }
  $command = (& $quote $exe) + ' -NoProfile -NonInteractive -File ' + (& $quote $PSCommandPath) + ' -Gate -SpecFile ' + (& $quote $file)
  $job = [PostmanWriterJob]::Start($exe,$command,$spec.cwd,[ref]$handle)
  $deadline = [DateTime]::UtcNow.AddSeconds($spec.timeout)
  $timedOut = $false
  while ([PostmanWriterJob]::Active($job) -gt 0) {
    if (!$timedOut -and [DateTime]::UtcNow -ge $deadline) {
      $timedOut = $true
      if (![PostmanWriterJob]::TerminateJobObject($job,1)) { throw 'Native writer termination failed' }
    }
    Start-Sleep -Milliseconds 25
  }
  [Console]::Out.WriteLine((@{version=1;jobSettled=$true;exitCode=[PostmanWriterJob]::ExitCode($handle);timedOut=$timedOut} | ConvertTo-Json -Compress))
} finally {
  if ($handle -ne [IntPtr]::Zero) { [void][PostmanWriterJob]::CloseHandle($handle) }
  if ($job -ne [IntPtr]::Zero) { [void][PostmanWriterJob]::CloseHandle($job) }
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
}
