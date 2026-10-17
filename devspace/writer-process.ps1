param([switch]$Gate, [string]$SpecFile, [string]$ControlPipe)
$ErrorActionPreference = 'Stop'

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
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
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
  public static IntPtr Open(string name) { return OpenJobObject(0x0004|0x0008,false,name); }
  public static void ProtectPipe(IntPtr handle) { Check(SetHandleInformation(handle,1,0)); }
  public static IntPtr Start(string exe,string command,string cwd,string name,out IntPtr process) {
    IntPtr job=CreateJobObject(IntPtr.Zero,name); Check(job!=IntPtr.Zero);
    if(Marshal.GetLastWin32Error()==183) { CloseHandle(job); throw new InvalidOperationException("Native job already exists"); }
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
  public static async System.Threading.Tasks.Task Pump(System.IO.Stream input,System.IO.Stream output) {
    byte[] buffer=new byte[8192]; int count;
    while((count=await input.ReadAsync(buffer,0,buffer.Length))>0) {
      try { await output.WriteAsync(buffer,0,count); await output.FlushAsync(); }
      catch { output=System.IO.Stream.Null; }
    }
  }
  public static System.Threading.Tasks.Task<string> ReadControl() {
    return System.Threading.Tasks.Task.Run(() => Console.In.ReadLine());
  }
}
'@
if ($Gate) {
  $spec = Get-Content -LiteralPath $SpecFile -Raw -Encoding utf8 | ConvertFrom-Json
  $pipe = [System.IO.Pipes.AnonymousPipeClientStream]::new([System.IO.Pipes.PipeDirection]::Out,$ControlPipe)
  [PostmanWriterJob]::ProtectPipe($pipe.SafePipeHandle.DangerousGetHandle())
  $events = [System.IO.StreamWriter]::new($pipe)
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $spec.shell
  $start.WorkingDirectory = $spec.cwd
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in $spec.args) { $start.ArgumentList.Add([string]$argument) }
  $start.RedirectStandardInput = $true
  $child = [System.Diagnostics.Process]::Start($start)
  $output = [PostmanWriterJob]::Pump($child.StandardOutput.BaseStream,[Console]::OpenStandardError())
  $errors = [PostmanWriterJob]::Pump($child.StandardError.BaseStream,[Console]::OpenStandardError())
  if ($spec.stdin) { $child.StandardInput.Write([string]$spec.command) }
  $child.StandardInput.Close()
  $child.WaitForExit()
  try { $events.WriteLine((@{version=1;event='foreground';exitCode=$child.ExitCode} | ConvertTo-Json -Compress)); $events.Flush() } catch {}
  try { $events.Dispose() } catch {}
  try { [System.Threading.Tasks.Task]::WhenAll([System.Threading.Tasks.Task[]]@($output,$errors)).GetAwaiter().GetResult() } catch {}
  exit $child.ExitCode
}

# Only this helper owns the named native handle. Node/UI/transport EOF is not a
# stop request. The anonymous event pipe is not inherited by the shell command.
function Write-NativeEvent($value) {
  try { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress)); [Console]::Out.Flush() } catch {}
}
$job = [IntPtr]::Zero
$handle = [IntPtr]::Zero
$settled = $false
$nativePipe = $null
$file = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'postman-writer-' + [guid]::NewGuid().ToString() + '.json')
try {
  $spec = [Console]::In.ReadLine() | ConvertFrom-Json
  if (!$spec.jobName -or $spec.jobName -notmatch '^Local\\DSH_Postman_[a-f0-9-]{36}_[a-f0-9]{64}$') { throw 'Invalid native job identity' }
  if ($spec.action -in @('inspect','stop')) {
    $job = [PostmanWriterJob]::Open($spec.jobName)
    if ($job -eq [IntPtr]::Zero) { Write-NativeEvent @{version=1;event='unknown'}; exit 0 }
    if ($spec.action -eq 'stop') {
      if (![PostmanWriterJob]::TerminateJobObject($job,1)) { throw 'Native writer stop failed' }
      $deadline = [DateTime]::UtcNow.AddSeconds(3)
      while ([PostmanWriterJob]::Active($job) -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
    }
    $active = [PostmanWriterJob]::Active($job)
    Write-NativeEvent @{version=1;event='inspection';activeProcesses=$active;treeSettled=($active -eq 0);stopRequested=($spec.action -eq 'stop')}
    # This is an additional handle, not the lifetime owner. Closing it cannot
    # kill a running job retained by its original helper.
    [void][PostmanWriterJob]::CloseHandle($job); $job=[IntPtr]::Zero
    exit 0
  }
  if (!$spec.shell -or !$spec.cwd -or !($spec.timeout -gt 0) -or $spec.timeout -gt 300) { throw 'Invalid native writer spec' }
  $spec | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $file -Encoding utf8 -NoNewline
  $nativePipe = [System.IO.Pipes.AnonymousPipeServerStream]::new([System.IO.Pipes.PipeDirection]::In,[System.IO.HandleInheritability]::Inheritable)
  $exe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $quote = { param($value) '"' + $value.Replace('"','\"') + '"' }
  $command = (& $quote $exe) + ' -NoProfile -NonInteractive -File ' + (& $quote $PSCommandPath) + ' -Gate -SpecFile ' + (& $quote $file) + ' -ControlPipe ' + $nativePipe.GetClientHandleAsString()
  $job = [PostmanWriterJob]::Start($exe,$command,$spec.cwd,$spec.jobName,[ref]$handle)
  $nativePipe.DisposeLocalCopyOfClientHandle()
  $reader = [System.IO.StreamReader]::new($nativePipe)
  $foreground = $reader.ReadLineAsync()
  $control = [PostmanWriterJob]::ReadControl()
  Write-NativeEvent @{version=1;event='started'}
  while ([PostmanWriterJob]::Active($job) -gt 0) {
    if ($foreground -and $foreground.IsCompleted) {
      try { $line=$foreground.GetAwaiter().GetResult(); if ($line) { Write-NativeEvent ($line | ConvertFrom-Json) } } catch {}
      $foreground=$null
    }
    if ($control -and $control.IsCompleted) {
      try { $line=$control.GetAwaiter().GetResult() } catch { $line=$null }
      if ($line) {
        try {
          $intent=$line | ConvertFrom-Json
          if ($intent.action -eq 'stop') {
            if (![PostmanWriterJob]::TerminateJobObject($job,1)) { throw 'Native writer stop failed' }
            Write-NativeEvent @{version=1;event='stop_requested'}
          }
        } catch {}
        try { $control=[PostmanWriterJob]::ReadControl() } catch { $control=$null }
      } else { $control=$null }
    }
    Start-Sleep -Milliseconds 25
  }
  $settled=$true
  Write-NativeEvent @{version=1;event='settled';jobSettled=$true;exitCode=[PostmanWriterJob]::ExitCode($handle)}
} finally {
  # An exceptional control/pipe failure must not turn handle disposal into an
  # implicit background stop. Retain ownership until actual exit or named stop.
  if ($job -ne [IntPtr]::Zero -and !$settled) {
    try { while ([PostmanWriterJob]::Active($job) -gt 0) { Start-Sleep -Milliseconds 100 } } catch { while ($true) { Start-Sleep -Seconds 1 } }
  }
  if ($nativePipe) { $nativePipe.Dispose() }
  if ($handle -ne [IntPtr]::Zero) { [void][PostmanWriterJob]::CloseHandle($handle) }
  if ($job -ne [IntPtr]::Zero) { [void][PostmanWriterJob]::CloseHandle($job) }
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
}
