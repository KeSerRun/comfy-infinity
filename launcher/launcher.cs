using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
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

        bool firstRun = !File.Exists(Path.Combine(root, "launcher", "desktop", "node_modules", "electron", "dist", "electron.exe"));
        if (firstRun)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallForm(root, batch));
            return;
        }

        try
        {
            int exitCode = RunBatch(root, batch);
            if (exitCode != 0)
            {
                MessageBox.Show(
                    "Comfy Infinity 启动失败。请查看 launcher/launcher.log 获取详细信息。",
                    "Comfy Infinity",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "Comfy Infinity 启动失败：\n" + error.Message,
                "Comfy Infinity",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    internal static int RunBatch(string root, string batch)
    {
        ProcessStartInfo startInfo = new ProcessStartInfo
        {
            FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
            Arguments = "/d /c \"" + batch + "\"",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };

        using (Process process = Process.Start(startInfo))
        {
            if (process == null) return 1;
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private sealed class InstallForm : Form
    {
        private readonly string root;
        private readonly string batch;
        private readonly Label statusLabel;

        internal InstallForm(string root, string batch)
        {
            this.root = root;
            this.batch = batch;

            Text = "Comfy Infinity";
            ClientSize = new Size(420, 174);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ControlBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(15, 17, 24);
            ForeColor = Color.FromArgb(232, 236, 243);
            Font = new Font("Segoe UI", 9F);
            try
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch
            {
                // 图标不可用时使用默认窗口图标。
            }

            Label title = new Label
            {
                Text = "Comfy Infinity",
                ForeColor = Color.FromArgb(232, 236, 243),
                Font = new Font("Segoe UI", 15F, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(28, 26)
            };

            statusLabel = new Label
            {
                Text = "首次启动，正在下载并准备桌面运行资源…",
                ForeColor = Color.FromArgb(170, 180, 196),
                AutoSize = false,
                Location = new Point(30, 64),
                Size = new Size(360, 24)
            };

            ProgressBar progress = new ProgressBar
            {
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 28,
                Location = new Point(30, 96),
                Size = new Size(360, 12)
            };

            Label hint = new Label
            {
                Text = "首次启动需要下载桌面组件，完成后会自动打开工作台。",
                ForeColor = Color.FromArgb(120, 130, 146),
                AutoSize = false,
                Location = new Point(30, 122),
                Size = new Size(360, 22)
            };

            Controls.Add(title);
            Controls.Add(statusLabel);
            Controls.Add(progress);
            Controls.Add(hint);
            Shown += OnShown;
        }

        private void OnShown(object sender, EventArgs e)
        {
            Thread worker = new Thread(RunInstall);
            worker.IsBackground = true;
            worker.Start();
        }

        private void RunInstall()
        {
            string failure = "";
            try
            {
                int exitCode = Program.RunBatch(root, batch);
                if (exitCode != 0)
                {
                    failure = "下载或安装桌面运行资源失败。请检查网络和 npm 配置后重试，详细信息见 launcher/launcher.log。";
                }
            }
            catch (Exception error)
            {
                failure = "下载桌面运行资源失败：\n" + error.Message;
            }

            if (failure.Length > 0)
            {
                BeginInvoke(new Action(() =>
                {
                    MessageBox.Show(
                        failure,
                        "Comfy Infinity",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }));
            }
            BeginInvoke(new Action(Close));
        }
    }
}
