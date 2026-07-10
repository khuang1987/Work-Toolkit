import datetime
import tkinter as tk
from tkinter import ttk
import calendar
from tkcalendar import Calendar

# Shift workers
workers = ["申伟", "沈俊杰", "李晓潜"]

# Initial shift assignments and days worked
initial_schedule = {
    "2025/2/19": {"Shift-1": {"worker": "李晓潜", "day": 1}, "Shift-2": {"worker": "沈俊杰", "day": 3}, "Rest": {"worker": "申伟", "day": 1}},
}

def get_assignment(initial, day):
    # 初始为Shift-1
    if initial == "Shift-1":
        if 1 <= day <= 4:
            return "Shift-1"
        elif 5 <= day <= 6:
            return "Rest"
        elif 7 <= day <= 10:
            return "Shift-2"
        else:
            return "Rest"
    # 初始为Shift-2
    elif initial == "Shift-2":
        if 1 <= day <= 4:
            return "Shift-2"
        elif 5 <= day <= 6:
            return "Rest"
        elif 7 <= day <= 10:
            return "Shift-1"
        else:
            return "Rest"
    # 初始为Rest
    elif initial == "Rest":
        if 1 <= day <= 2:
            return "Rest"
        elif 3 <= day <= 6:
            return "Shift-2"
        elif 7 <= day <= 10:
            return "Shift-1"
        else:
            return "Rest"

def generate_schedule(start_date, end_date):
    schedule = []
    # 使用 initial_schedule 中最早的日期作为基准日期
    base_date_str = min(initial_schedule.keys(), key=lambda d: datetime.datetime.strptime(d, "%Y/%m/%d"))
    base_date = datetime.datetime.strptime(base_date_str, "%Y/%m/%d").date()
    # 构造每个员工的初始状态，格式为 {worker: (base_role, base_day)}
    # 对于初始为“Rest”的员工，调整 base_day 为 5，确保当天该员工在休息段
    initial_state = {}
    for shift in ["Shift-1", "Shift-2", "Rest"]:
        worker_data = initial_schedule[base_date_str].get(shift)
        if isinstance(worker_data, dict):
            w = worker_data.get("worker")
            d = worker_data.get("day")
            if w:
                if shift == "Rest":
                    initial_state[w] = (shift, 5)
                else:
                    initial_state[w] = (shift, d)
        elif isinstance(worker_data, str):
            if shift == "Rest":
                initial_state[worker_data] = (shift, 5)
            else:
                initial_state[worker_data] = (shift, 1)

    # 定义每个员工的 A 和 B 班次
    role_map = {}
    for worker, (role, base_day) in initial_state.items():
        if role == "Shift-1":
            role_map[worker] = {"A": "Shift-1", "B": "Shift-2"}
        elif role == "Shift-2":
            role_map[worker] = {"A": "Shift-2", "B": "Shift-1"}
        else:  # 初始为 Rest的员工，任意指定
            role_map[worker] = {"A": "Shift-1", "B": "Shift-2"}

    cycle_length = 12
    delta = (end_date - start_date).days
    for i in range(delta + 1):
        current_date = start_date + datetime.timedelta(days=i)
        date_str = current_date.strftime("%Y/%m/%d")
        day_assignments = {}
        for worker in workers:
            offset = (current_date - base_date).days  # 使用负值运算
            # 如果该员工不在初始状态中，默认为 Shift-1 且 base_day=1
            base_role, base_day = initial_state.get(worker, ("Shift-1", 1))
            new_day = ((base_day - 1 + offset) % cycle_length) + 1
            if 1 <= new_day <= 4:
                assignment = role_map[worker]["A"]
                work_day = new_day
            elif 5 <= new_day <= 6:
                assignment = "Rest"
                work_day = new_day - 4  # 结果为 1-2
            elif 7 <= new_day <= 10:
                assignment = role_map[worker]["B"]
                work_day = new_day - 6  # 结果 1-4
            else:  # new_day 11-12
                assignment = "Rest"
                work_day = new_day - 10  # 结果 1-2
            day_assignments[worker] = (assignment, work_day)
        entry = {"date": date_str}
        for pos in ["Shift-1", "Shift-2", "Rest"]:
            entry[pos] = next((f"{w}-{d}" for w, (a, d) in day_assignments.items() if a == pos), "无-0")
        schedule.append(entry)
    return schedule

def display_schedule_gui(date=None):
    root = tk.Tk()
    root.title("Shift Schedule")
    root.geometry("400x600")  # 设置窗体宽度为600像素，高度随意
    current_date = datetime.datetime.now().date()

    cal = Calendar(root, selectmode="day", date_pattern="yyyy/MM/dd")
    cal.pack(pady=10, fill=tk.BOTH, expand=True)  # 日历缩放填充

    def display_single_day_schedule(date_obj):
        start_range = date_obj - datetime.timedelta(days=4)
        end_range = date_obj + datetime.timedelta(days=4)
        sel_date_str = date_obj.strftime("%Y/%m/%d")
        cal.selection_set(sel_date_str)
        for item in tree.get_children():
            tree.delete(item)
        sch = generate_schedule(start_range, end_range)
        today_str = datetime.datetime.now().strftime("%Y/%m/%d")
        for entry in sch:
            tags = ("today",) if entry["date"] == today_str else ()
            tree.insert("", tk.END, values=(
                entry["date"],
                entry.get("Shift-1", ""),
                entry.get("Shift-2", ""),
                entry.get("Rest", "")
            ), tags=tags)

    def calendar_select():
        nonlocal current_date
        # 获取日历中选定的日期
        selected_date_str = cal.get_date()
        selected_date = datetime.datetime.strptime(selected_date_str, "%Y/%m/%d").date()
        display_single_day_schedule(selected_date)
        current_date = selected_date

    def go_to_today():
        nonlocal current_date
        # 直接将当前日期设置为今天
        current_date = datetime.datetime.now().date()
        display_single_day_schedule(current_date)
        cal.selection_set(current_date)  # 更新日历显示

    # 绑定日历选择事件，点击日期后直接跳转
    cal.bind("<<CalendarSelected>>", lambda event: calendar_select())

    def prev_day():
        nonlocal current_date
        current_date -= datetime.timedelta(days=1)
        display_single_day_schedule(current_date)

    def next_day():
        nonlocal current_date
        current_date += datetime.timedelta(days=1)
        display_single_day_schedule(current_date)

    tree = ttk.Treeview(root, columns=("Date", "Shift-1", "Shift-2", "Rest"), show="headings")
    tree.heading("Date", text="Date")
    tree.heading("Shift-1", text="Shift-1")
    tree.heading("Shift-2", text="Shift-2")
    tree.heading("Rest", text="Rest")
    tree.pack(padx=10, pady=10, fill=tk.BOTH, expand=True)  # 调整为随窗体缩放
    tree.tag_configure("today", background="lightgreen")

    # 设置列宽，确保初始值能够完全显示在窗体内
    tree.column("Date", width=100)
    tree.column("Shift-1", width=100)
    tree.column("Shift-2", width=100)
    tree.column("Rest", width=100)

    btn_frame = tk.Frame(root)
    btn_frame.pack(pady=10)
    prev_button = tk.Button(btn_frame, text="前一天", command=prev_day)
    prev_button.pack(side=tk.LEFT, padx=5)
    update_button = tk.Button(btn_frame, text="今天", command=go_to_today)
    update_button.pack(side=tk.LEFT, padx=5)
    next_button = tk.Button(btn_frame, text="后一天", command=next_day)
    next_button.pack(side=tk.LEFT, padx=5)

    display_single_day_schedule(current_date)
    root.mainloop()

def main():
    display_schedule_gui()

if __name__ == "__main__":
    main()
