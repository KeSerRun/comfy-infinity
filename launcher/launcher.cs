using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string batch = Path.Combine(root, "start-desktop.bat");
        if (!File.Exists(batch))
        {
            MessageBox.Show(
                "start-desktop.bat was not found next to this launcher.",
                "Comfy Infinity",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        Process.Start(new ProcessStartInfo
        {
            FileName = batch,
            WorkingDirectory = root,
            UseShellExecute = true
        });
    }
}
