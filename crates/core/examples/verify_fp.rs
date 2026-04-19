fn main() {
    let fp = django_orm_core::discovery::file_fingerprint("app/models.py", 42, 1_234_567_890);
    println!("rust:   {fp}");
}
