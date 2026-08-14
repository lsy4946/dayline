using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace DaylineUpdateHelper
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Dictionary<string, string> options = ParseArguments(args);
            bool preview = options.ContainsKey("preview");
            if (!preview && !options.ContainsKey("installer")) return;

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new UpdateInstallerForm(options, preview));
        }

        private static Dictionary<string, string> ParseArguments(string[] args)
        {
            Dictionary<string, string> options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int index = 0; index < args.Length; index += 1)
            {
                string key = args[index];
                if (!key.StartsWith("--", StringComparison.Ordinal)) continue;
                key = key.Substring(2);
                string value = "true";
                if (index + 1 < args.Length && !args[index + 1].StartsWith("--", StringComparison.Ordinal))
                {
                    value = args[index + 1];
                    index += 1;
                }
                options[key] = value;
            }
            return options;
        }
    }

    internal sealed class UpdateInstallerForm : Form
    {
        private static readonly Color Ink = Color.FromArgb(38, 59, 50);
        private static readonly Color Muted = Color.FromArgb(116, 130, 121);
        private static readonly Color Green = Color.FromArgb(37, 95, 75);
        private static readonly Color SoftGreen = Color.FromArgb(232, 241, 235);
        private static readonly Color Ivory = Color.FromArgb(251, 249, 242);
        private static readonly Color Line = Color.FromArgb(222, 228, 222);
        private static readonly Color Coral = Color.FromArgb(188, 103, 87);

        private readonly Dictionary<string, string> options;
        private readonly bool preview;
        private readonly Label headline;
        private readonly Label description;
        private readonly Label percentLabel;
        private readonly Label elapsedLabel;
        private readonly Label footerLabel;
        private readonly CalendarBlocks blocks;
        private readonly Button primaryButton;
        private readonly Button secondaryButton;
        private readonly System.Windows.Forms.Timer animationTimer;
        private readonly Stopwatch elapsed = new Stopwatch();
        private readonly Random random = new Random();
        private readonly string[] messages = new string[]
        {
            "캘린더 블록을 차곡차곡 쌓는 중",
            "일정들의 자리를 반듯하게 맞추는 중",
            "마지막 체크 표시를 다듬는 중",
            "새 Dayline에 오늘을 옮겨 담는 중"
        };

        private int progress = 52;
        private int progressTicks;
        private int progressTickMilliseconds;
        private int messageMilliseconds;
        private int totalAnimationMilliseconds;
        private int messageIndex;
        private bool installerRunning;
        private bool allowClose;

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int widthEllipse, int heightEllipse);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr handle);

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);

        internal UpdateInstallerForm(Dictionary<string, string> options, bool preview)
        {
            this.options = options;
            this.preview = preview;

            Text = "Dayline 업데이트";
            ClientSize = new Size(620, 520);
            MinimumSize = new Size(560, 480);
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Ivory;
            ForeColor = Ink;
            ShowInTaskbar = true;
            TopMost = !preview;
            AutoScaleMode = AutoScaleMode.Dpi;
            DoubleBuffered = true;
            Padding = new Padding(46, 34, 46, 32);

            LogoMark logo = new LogoMark();
            logo.Location = new Point(46, 34);
            logo.Size = new Size(42, 42);
            Controls.Add(logo);

            Label brand = CreateLabel("DAYLINE", 12F, FontStyle.Bold, Green, ContentAlignment.MiddleLeft);
            brand.Location = new Point(98, 38);
            brand.Size = new Size(150, 23);
            Controls.Add(brand);

            Label eyebrow = CreateLabel("DAYLINE UPDATE", 8.5F, FontStyle.Bold, Color.FromArgb(125, 140, 131), ContentAlignment.MiddleLeft);
            eyebrow.Location = new Point(99, 58);
            eyebrow.Size = new Size(114, 18);
            Controls.Add(eyebrow);

            Label version = CreateLabel(VersionCopy(), 8.5F, FontStyle.Bold, Green, ContentAlignment.MiddleCenter);
            version.Location = new Point(220, 54);
            version.Size = new Size(156, 25);
            version.BackColor = SoftGreen;
            Controls.Add(version);

            messageIndex = random.Next(messages.Length);
            headline = CreateLabel(AnimatedMessage(), 20F, FontStyle.Bold, Ink, ContentAlignment.MiddleCenter);
            headline.Location = new Point(38, 112);
            headline.Size = new Size(544, 44);
            Controls.Add(headline);

            description = CreateLabel(String.Empty, 10F, FontStyle.Regular, Muted, ContentAlignment.MiddleCenter);
            description.Location = new Point(42, 157);
            description.Size = new Size(536, 29);
            description.Visible = false;
            Controls.Add(description);

            percentLabel = CreateLabel(progress + "%", 10F, FontStyle.Bold, Green, ContentAlignment.MiddleCenter);
            percentLabel.Location = new Point(260, 194);
            percentLabel.Size = new Size(100, 30);
            percentLabel.BackColor = SoftGreen;
            Controls.Add(percentLabel);

            blocks = new CalendarBlocks();
            blocks.Location = new Point(92, 246);
            blocks.Size = new Size(436, 72);
            blocks.Progress = progress;
            Controls.Add(blocks);

            Label safeCopy = CreateLabel("●  일정과 설정은 안전하게 보존됩니다", 9F, FontStyle.Bold, Color.FromArgb(97, 116, 106), ContentAlignment.MiddleCenter);
            safeCopy.Location = new Point(100, 354);
            safeCopy.Size = new Size(420, 22);
            Controls.Add(safeCopy);

            elapsedLabel = CreateLabel("보통 10~30초 정도 걸려요", 8.5F, FontStyle.Regular, Color.FromArgb(151, 162, 155), ContentAlignment.MiddleCenter);
            elapsedLabel.Location = new Point(100, 380);
            elapsedLabel.Size = new Size(420, 20);
            Controls.Add(elapsedLabel);

            footerLabel = CreateLabel("설치가 끝나면 Dayline이 자동으로 다시 열립니다", 8.5F, FontStyle.Regular, Color.FromArgb(151, 162, 155), ContentAlignment.MiddleCenter);
            footerLabel.Location = new Point(100, 463);
            footerLabel.Size = new Size(420, 20);
            footerLabel.Visible = !preview;
            Controls.Add(footerLabel);

            primaryButton = CreateButton("다시 시도", true);
            primaryButton.Location = new Point(92, 451);
            primaryButton.Size = new Size(150, 42);
            primaryButton.Visible = false;
            primaryButton.Click += delegate { StartInstaller(); };
            Controls.Add(primaryButton);

            secondaryButton = CreateButton(preview ? "미리보기 닫기" : "Dayline으로 돌아가기", false);
            secondaryButton.Location = preview ? new Point(220, 451) : new Point(252, 451);
            secondaryButton.Size = preview ? new Size(180, 42) : new Size(276, 42);
            secondaryButton.Visible = preview;
            secondaryButton.Click += delegate
            {
                allowClose = true;
                if (!preview) TryRestartDayline();
                Close();
            };
            Controls.Add(secondaryButton);

            animationTimer = new System.Windows.Forms.Timer();
            animationTimer.Interval = 100;
            animationTimer.Tick += OnAnimationTick;

            MouseDown += BeginWindowDrag;
            foreach (Control child in Controls)
            {
                if (!(child is Button)) child.MouseDown += BeginWindowDrag;
            }
            Shown += OnShown;
            FormClosing += OnFormClosing;
            Resize += delegate { ApplyRoundedRegion(); };
        }

        protected override void OnPaint(PaintEventArgs eventArgs)
        {
            base.OnPaint(eventArgs);
            Graphics graphics = eventArgs.Graphics;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (SolidBrush accent = new SolidBrush(Green))
            {
                graphics.FillRectangle(accent, 0, 0, ClientSize.Width, 6);
            }
            using (Pen border = new Pen(Color.FromArgb(215, 222, 216)))
            {
                graphics.DrawRectangle(border, 0, 0, ClientSize.Width - 1, ClientSize.Height - 1);
            }
        }

        private void OnShown(object sender, EventArgs eventArgs)
        {
            ApplyRoundedRegion();
            SignalReady();
            elapsed.Start();
            headline.ForeColor = Ivory;
            animationTimer.Start();
            if (preview)
            {
                progress = 68;
                UpdateProgressVisuals();
                SchedulePreviewCapture();
                return;
            }
            StartInstaller();
        }

        private void StartInstaller()
        {
            if (installerRunning) return;
            installerRunning = true;
            progress = 52;
            progressTicks = 0;
            progressTickMilliseconds = 0;
            messageMilliseconds = 0;
            totalAnimationMilliseconds = 0;
            messageIndex = NextMessageIndex(messageIndex);
            headline.Text = AnimatedMessage();
            headline.ForeColor = Ivory;
            description.Text = String.Empty;
            description.Visible = false;
            percentLabel.Visible = true;
            percentLabel.ForeColor = Green;
            percentLabel.BackColor = SoftGreen;
            primaryButton.Visible = false;
            secondaryButton.Visible = false;
            footerLabel.Visible = true;
            UpdateProgressVisuals();

            Task.Factory.StartNew<int>(RunInstaller, CancellationToken.None, TaskCreationOptions.None, TaskScheduler.Default)
                .ContinueWith(delegate(Task<int> task)
                {
                    if (IsDisposed) return;
                    BeginInvoke(new Action(delegate
                    {
                        installerRunning = false;
                        if (task.IsFaulted || task.Result != 0)
                        {
                            ShowFailure();
                        }
                        else
                        {
                            ShowSuccess();
                        }
                    }));
                }, TaskScheduler.Default);
        }

        private int RunInstaller()
        {
            int parentPid;
            if (TryReadIntOption("parent-pid", out parentPid) && parentPid > 0)
            {
                try
                {
                    using (Process parent = Process.GetProcessById(parentPid)) parent.WaitForExit();
                }
                catch (ArgumentException)
                {
                }
            }

            string installerPath = ReadOption("installer");
            if (String.IsNullOrWhiteSpace(installerPath) || !File.Exists(installerPath)) return 2;
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = installerPath;
            startInfo.Arguments = "/S --updated --force-run";
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            using (Process installer = Process.Start(startInfo))
            {
                if (installer == null) return 3;
                installer.WaitForExit();
                return installer.ExitCode;
            }
        }

        private void ShowFailure()
        {
            animationTimer.Stop();
            headline.Text = "업데이트를 마무리하지 못했어요";
            headline.ForeColor = Ink;
            description.Text = "설치가 중간에 멈췄습니다. 다시 시도하거나 기존 Dayline으로 돌아갈 수 있어요.";
            description.Visible = true;
            percentLabel.Text = "일시 중지";
            percentLabel.ForeColor = Coral;
            percentLabel.BackColor = Color.FromArgb(248, 234, 229);
            footerLabel.Visible = false;
            primaryButton.Visible = true;
            secondaryButton.Visible = true;
        }

        private async void ShowSuccess()
        {
            animationTimer.Stop();
            progress = 100;
            headline.Text = "새 Dayline을 여는 중…";
            headline.ForeColor = Ink;
            description.Text = "일정과 설정을 그대로 두고 업데이트를 완료했습니다.";
            description.Visible = true;
            elapsedLabel.Text = "곧 새 버전이 시작됩니다";
            footerLabel.Text = "업데이트가 완료되었습니다";
            UpdateProgressVisuals();
            await Task.Delay(950);
            allowClose = true;
            Close();
        }

        private void OnAnimationTick(object sender, EventArgs eventArgs)
        {
            int elapsedMilliseconds = animationTimer.Interval;
            totalAnimationMilliseconds += elapsedMilliseconds;
            messageMilliseconds += elapsedMilliseconds;
            progressTickMilliseconds += elapsedMilliseconds;

            if (messageMilliseconds >= 5000)
            {
                messageMilliseconds -= 5000;
                messageIndex = NextMessageIndex(messageIndex);
            }

            while (progressTickMilliseconds >= 650)
            {
                progressTickMilliseconds -= 650;
                progressTicks += 1;
                if (!preview && installerRunning)
                {
                    int step = progress < 72 ? 2 : progress < 86 ? 1 : progressTicks % 3 == 0 ? 1 : 0;
                    progress = Math.Min(94, progress + step);
                }
                else if (preview)
                {
                    progress = progress >= 88 ? 58 : progress + 1;
                }
            }

            headline.Text = AnimatedMessage();
            headline.ForeColor = FadeColor();
            long seconds = Math.Max(0, (long)elapsed.Elapsed.TotalSeconds);
            elapsedLabel.Text = seconds < 30
                ? "보통 10~30초 정도 걸려요"
                : seconds + "초째 차분히 진행 중이에요";
            UpdateProgressVisuals();
        }

        private void UpdateProgressVisuals()
        {
            percentLabel.Text = progress + "%";
            blocks.Progress = progress;
            blocks.Invalidate();
        }

        private string AnimatedMessage()
        {
            int dotCount = (totalAnimationMilliseconds / 500) % 3 + 1;
            return messages[messageIndex] + new String('.', dotCount);
        }

        private int NextMessageIndex(int previous)
        {
            if (messages.Length < 2) return 0;
            int candidate = random.Next(messages.Length - 1);
            return candidate >= previous ? candidate + 1 : candidate;
        }

        private Color FadeColor()
        {
            const int fadeDuration = 260;
            double opacity = 1D;
            if (messageMilliseconds < fadeDuration)
            {
                opacity = messageMilliseconds / (double)fadeDuration;
            }
            else if (messageMilliseconds > 5000 - fadeDuration)
            {
                opacity = (5000 - messageMilliseconds) / (double)fadeDuration;
            }
            opacity = Math.Max(0D, Math.Min(1D, opacity));
            return Blend(Ivory, Ink, opacity);
        }

        private static Color Blend(Color from, Color to, double amount)
        {
            int red = (int)Math.Round(from.R + (to.R - from.R) * amount);
            int green = (int)Math.Round(from.G + (to.G - from.G) * amount);
            int blue = (int)Math.Round(from.B + (to.B - from.B) * amount);
            return Color.FromArgb(red, green, blue);
        }

        private void SignalReady()
        {
            string readyFile = ReadOption("ready-file");
            if (String.IsNullOrWhiteSpace(readyFile)) return;
            try
            {
                File.WriteAllText(readyFile, "ready");
            }
            catch
            {
            }
        }

        private void SchedulePreviewCapture()
        {
            string capturePath = ReadOption("capture");
            if (String.IsNullOrWhiteSpace(capturePath)) return;
            System.Windows.Forms.Timer captureTimer = new System.Windows.Forms.Timer();
            captureTimer.Interval = 900;
            captureTimer.Tick += delegate
            {
                captureTimer.Stop();
                try
                {
                    string directory = Path.GetDirectoryName(capturePath);
                    if (!String.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
                    using (Bitmap bitmap = new Bitmap(Width, Height))
                    {
                        DrawToBitmap(bitmap, new Rectangle(0, 0, Width, Height));
                        bitmap.Save(capturePath, System.Drawing.Imaging.ImageFormat.Png);
                    }
                }
                finally
                {
                    captureTimer.Dispose();
                    allowClose = true;
                    Close();
                }
            };
            captureTimer.Start();
        }

        private void TryRestartDayline()
        {
            string appPath = ReadOption("app");
            if (String.IsNullOrWhiteSpace(appPath) || !File.Exists(appPath)) return;
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo(appPath, "--updated");
                startInfo.UseShellExecute = true;
                Process.Start(startInfo);
            }
            catch
            {
            }
        }

        private string VersionCopy()
        {
            string from = ReadOption("from-version");
            string to = ReadOption("to-version");
            if (String.IsNullOrWhiteSpace(from)) from = "0.3.41";
            if (String.IsNullOrWhiteSpace(to)) to = preview ? "0.3.42" : "새 버전";
            if (!from.StartsWith("v", StringComparison.OrdinalIgnoreCase)) from = "v" + from;
            if (!to.StartsWith("v", StringComparison.OrdinalIgnoreCase) && to != "새 버전") to = "v" + to;
            return from + "  →  " + to;
        }

        private string ReadOption(string name)
        {
            string value;
            return options.TryGetValue(name, out value) ? value : null;
        }

        private bool TryReadIntOption(string name, out int value)
        {
            return Int32.TryParse(ReadOption(name), out value);
        }

        private void ApplyRoundedRegion()
        {
            IntPtr regionHandle = CreateRoundRectRgn(0, 0, Width + 1, Height + 1, 28, 28);
            Region = Region.FromHrgn(regionHandle);
            DeleteObject(regionHandle);
        }

        private void BeginWindowDrag(object sender, MouseEventArgs eventArgs)
        {
            if (eventArgs.Button != MouseButtons.Left) return;
            ReleaseCapture();
            SendMessage(Handle, 0xA1, new IntPtr(0x2), IntPtr.Zero);
        }

        private void OnFormClosing(object sender, FormClosingEventArgs eventArgs)
        {
            if (!allowClose) eventArgs.Cancel = true;
        }

        private static Label CreateLabel(string text, float size, FontStyle style, Color color, ContentAlignment alignment)
        {
            Label label = new Label();
            label.Text = text;
            label.Font = new Font("Malgun Gothic", size, style, GraphicsUnit.Point);
            label.ForeColor = color;
            label.BackColor = Color.Transparent;
            label.TextAlign = alignment;
            label.AutoEllipsis = true;
            return label;
        }

        private static Button CreateButton(string text, bool primary)
        {
            Button button = new Button();
            button.Text = text;
            button.Font = new Font("Malgun Gothic", 9F, FontStyle.Bold, GraphicsUnit.Point);
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.BorderColor = primary ? Green : Line;
            button.BackColor = primary ? Green : Color.White;
            button.ForeColor = primary ? Color.White : Ink;
            button.Cursor = Cursors.Hand;
            button.TabStop = true;
            return button;
        }
    }

    internal sealed class LogoMark : Control
    {
        internal LogoMark()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint, true);
            BackColor = Color.Transparent;
        }

        protected override void OnPaint(PaintEventArgs eventArgs)
        {
            Graphics graphics = eventArgs.Graphics;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(1, 1, Width - 3, Height - 3);
            using (GraphicsPath path = RoundedRectangle(bounds, 11))
            using (SolidBrush fill = new SolidBrush(Color.FromArgb(232, 241, 235)))
            using (Pen border = new Pen(Color.FromArgb(196, 215, 203)))
            {
                graphics.FillPath(fill, path);
                graphics.DrawPath(border, path);
            }
            using (Pen pen = new Pen(Color.FromArgb(37, 95, 75), 2F))
            {
                graphics.DrawRectangle(pen, 11, 10, 19, 21);
                graphics.DrawLine(pen, 11, 16, 30, 16);
                graphics.DrawLine(pen, 16, 7, 16, 13);
                graphics.DrawLine(pen, 25, 7, 25, 13);
                graphics.DrawLine(pen, 16, 21, 25, 21);
                graphics.DrawLine(pen, 16, 26, 22, 26);
            }
        }

        internal static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
        {
            int diameter = radius * 2;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    internal sealed class CalendarBlocks : Control
    {
        internal int Progress { get; set; }

        internal CalendarBlocks()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint, true);
            BackColor = Color.Transparent;
        }

        protected override void OnPaint(PaintEventArgs eventArgs)
        {
            Graphics graphics = eventArgs.Graphics;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            int gap = 10;
            int width = (ClientSize.Width - gap * 6) / 7;
            int filled = Math.Max(1, Math.Min(7, (int)Math.Ceiling(Progress / 14.3)));
            for (int index = 0; index < 7; index += 1)
            {
                Rectangle bounds = new Rectangle(index * (width + gap), 3, width, ClientSize.Height - 8);
                bool active = index < filled;
                using (GraphicsPath path = LogoMark.RoundedRectangle(bounds, 9))
                using (SolidBrush fill = new SolidBrush(active ? Color.FromArgb(229, 240, 232) : Color.FromArgb(243, 246, 243)))
                using (Pen border = new Pen(active ? Color.FromArgb(171, 201, 181) : Color.FromArgb(220, 228, 222)))
                {
                    graphics.FillPath(fill, path);
                    graphics.DrawPath(border, path);
                }
                Rectangle header = new Rectangle(bounds.Left + 1, bounds.Top + 1, bounds.Width - 2, 15);
                using (SolidBrush headerBrush = new SolidBrush(active ? Color.FromArgb(37, 95, 75) : Color.FromArgb(231, 236, 232)))
                {
                    graphics.FillRectangle(headerBrush, header);
                }
                using (Pen check = new Pen(active ? Color.FromArgb(37, 95, 75) : Color.FromArgb(198, 207, 201), 2F))
                {
                    int centerX = bounds.Left + bounds.Width / 2;
                    int centerY = bounds.Top + 39;
                    graphics.DrawLine(check, centerX - 7, centerY, centerX - 2, centerY + 5);
                    graphics.DrawLine(check, centerX - 2, centerY + 5, centerX + 8, centerY - 6);
                }
            }
        }
    }

}
